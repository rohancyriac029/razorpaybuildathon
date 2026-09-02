// Spec §6 block 1: the razorpay event types this system subscribes to, and
// the minimal payload shapes we read from each. Field paths confirmed
// against razorpay.com/docs/webhooks/payments/ and
// razorpay.com/docs/webhooks/subscriptions/ (2026-09-02).

export const SUBSCRIBED_EVENTS = [
  "payment.failed",
  "order.paid",
  "subscription.pending",
  "subscription.charged",
  "subscription.halted",
  "payment.downtime.started",
  "payment.downtime.resolved",
] as const;

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

export function isSubscribedEvent(event: string): event is SubscribedEvent {
  return (SUBSCRIBED_EVENTS as readonly string[]).includes(event);
}

export interface PaymentFailedPayload {
  event: "payment.failed";
  payload: {
    payment: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        currency: string;
        error_code: string | null;
        error_description: string | null;
        error_source: string | null;
        error_step: string | null;
        error_reason: string | null;
        customer_id?: string | null;
      };
    };
  };
  created_at: number;
}

export interface OrderPaidPayload {
  event: "order.paid";
  payload: {
    order: { entity: { id: string; amount: number } };
    payment?: { entity: { id: string } };
  };
  created_at: number;
}

// Confirmed: payload.payment.entity is present only if a payment attempt was
// made before the event fired; do not assume it. subscription.pending and
// subscription.halted are handled as lifecycle-only signals (src/webhooks/
// handler.ts) precisely because relying on an inconsistently-present nested
// payment entity for classification would be a real bug, not a shortcut.
export interface SubscriptionLifecyclePayload {
  event: "subscription.pending" | "subscription.halted" | "subscription.charged";
  payload: {
    subscription: {
      entity: {
        id: string;
        customer_id: string;
        status: string;
        auth_attempts?: number;
        paid_count?: number;
        plan_id?: string;
      };
    };
    payment?: { entity: { id: string; order_id: string; amount: number } };
  };
  created_at: number;
}

export interface DowntimePayload {
  event: "payment.downtime.started" | "payment.downtime.resolved";
  payload: {
    payment: {
      entity: {
        id: string;
        method: string;
        instrument?: Record<string, unknown>;
      };
    };
  };
  created_at: number;
}

export type WebhookPayload =
  | PaymentFailedPayload
  | OrderPaidPayload
  | SubscriptionLifecyclePayload
  | DowntimePayload;
