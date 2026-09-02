// Spec §4.5: transactional messaging in India requires pre-registered
// templates (DLT for SMS, pre-approved + opt-in for WhatsApp outside a
// 24h service window). The agent selects a templateId and fills permitted
// variables — it never writes customer-facing copy freehand.
//
// Deliberately minimal for block 5 (the Rules strategy only needs these
// three, legitimate templates). The "trap" template from spec §4.1.1/P14
// (retry_with_offer, carrying a discount_pct variable, that the agent
// might reach for and get structurally blocked from sending) belongs to
// block 6, alongside the Zod tool schema and the runtime validator that
// actually enforces P14 against it — building it here, disconnected from
// that enforcement layer, would be untested infrastructure nobody exercises
// yet.
import type { Channel } from "../types.js";

export interface MessageTemplate {
  id: string;
  channels: Channel[];
  allowedVars: readonly string[];
  description: string;
}

export const TEMPLATES: readonly MessageTemplate[] = [
  {
    id: "payment_retry_v2",
    channels: ["whatsapp", "sms", "email"],
    allowedVars: ["first_name", "amount", "link"],
    description: "Generic payment retry nudge — the default for most non-terminal failures.",
  },
  {
    id: "auth_incomplete_v1",
    channels: ["whatsapp", "sms"],
    allowedVars: ["first_name", "link"],
    description: "For AUTH_ABANDONED: OTP/3DS/UPI-collect was dropped mid-flow, not declined.",
  },
  {
    id: "instrument_update_v1",
    channels: ["whatsapp", "email"],
    allowedVars: ["first_name", "link"],
    description: "For INSTRUMENT: prompts supplying a new payment method, never names the old one's fault.",
  },
] as const;

export function getTemplate(id: string): MessageTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
