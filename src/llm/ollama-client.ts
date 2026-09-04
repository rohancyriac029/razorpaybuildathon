// Local-model provider, added when Gemini's free-tier daily quota made the
// real headline eval (npm run eval, config B, 120x3) impractical to finish
// in one sitting — see PROGRESS.md block 11. Ollama's /api/chat speaks an
// OpenAI-shaped tool-calling protocol (tools/tool_calls/role:"tool"), not
// Gemini's or Anthropic's, so this is a third, independent translation
// layer, not a copy of either.
//
// IMPORTANT, verified live 2026-09-03: Ollama does NOT support forcing tool
// choice — `tool_choice: "required"` is silently ignored by llama3.2:3b,
// unlike Gemini's `mode: "ANY"` or Anthropic's `tool_choice: {type: "any"}`.
// Spec §7 requires every turn end in exactly one tool call. Two mitigations,
// both found necessary by actually running the real multi-turn loop against
// this model, not assumed:
//
// 1. A textual "you must call a tool now" reminder appended to every tool
//    result (buildForceSuffix below) — without it, the model reliably drops
//    out of tool-calling mode as soon as turn 2, especially right after a
//    Zod-validation refusal it has to correct.
// 2. A last-resort extractor (extractEmbeddedToolCall) for the case where
//    the model, even with the reminder, answers in PLAIN TEXT that happens
//    to contain a JSON-shaped `{"name": "...", "parameters"|"arguments":
//    {...}}` object — a distinct, observed failure mode where the model
//    "knows" the right call but narrates it instead of invoking the real
//    tool-calling mechanism. Rescuing this is standard practice for small
//    local models and materially reduces the fallback-to-RulesStrategy rate
//    without ever inventing a name/args pair that wasn't in the response.
//
// If NEITHER mitigation finds a tool call, this client throws — feeding
// AgentStrategy's existing fallback-to-RulesStrategy safety net (spec
// §3.1.1) exactly the way a Gemini/Anthropic parse failure already does.
// This makes local-model unreliability visible in the eval's own
// fallback-rate metric rather than hidden behind a client that pretends
// forcing worked.
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse, LlmToolDef, LlmTurn } from "./client.js";

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

function toOllamaTools(tools: LlmToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// See module doc, mitigation 1. Only appended after at least one turn has
// happened (turns.length > 0 at the call site) — the very first call, with
// no prior turns, already forces a tool call reliably without it.
const FORCE_TOOL_SUFFIX =
  "\n\n(System reminder: you must respond with exactly one tool call now. Do not reply in plain text or narrate your decision — call the tool.)";

function toOllamaMessages(systemPrompt: string, userMessage: string, turns: LlmTurn[]): OllamaMessage[] {
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: turn.toolCall.name, arguments: turn.toolCall.input } }],
      });
    } else {
      messages.push({ role: "tool", content: turn.content + FORCE_TOOL_SUFFIX });
    }
  }
  return messages;
}

// See module doc, mitigation 2. Deliberately conservative: only fires on a
// well-formed {"name": "...", "parameters"|"arguments": {...}} object, and
// only extracts a name/args pair that is actually present in the text — it
// never invents one. `dotAll` (s flag) because the model sometimes wraps
// the object across multiple lines inside a longer prose explanation.
const EMBEDDED_TOOL_CALL_RE = /\{\s*"name"\s*:\s*"([a-zA-Z_][\w]*)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{.*?\})\s*\}/s;

function extractEmbeddedToolCall(text: string): { name: string; input: unknown } | null {
  const match = text.match(EMBEDDED_TOOL_CALL_RE);
  if (!match) return null;
  try {
    return { name: match[1]!, input: JSON.parse(match[2]!) };
  } catch {
    return null;
  }
}

export class OllamaClient implements LlmClient {
  readonly provider = "ollama";
  constructor(
    readonly model: string = "llama3.2:3b",
    private readonly baseUrl: string = "http://localhost:11434",
  ) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: toOllamaMessages(req.systemPrompt, req.userMessage, req.turns),
        tools: toOllamaTools(req.tools),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      message?: OllamaMessage;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const call = data.message?.tool_calls?.[0];
    const usage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
    };

    if (call) {
      return {
        toolCall: {
          id: `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: call.function.name,
          input: call.function.arguments,
        },
        usage,
      };
    }

    // See module doc, mitigation 2: the model answered in plain text, but
    // that text may still contain the tool call it "meant" to make.
    const embedded = extractEmbeddedToolCall(data.message?.content ?? "");
    if (embedded) {
      return {
        toolCall: {
          id: `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: embedded.name,
          input: embedded.input,
        },
        usage,
      };
    }

    // No forced tool choice locally, and no embedded call to rescue — a
    // real, expected failure mode for this model, not force-parsed further.
    throw new Error(
      `Ollama response contained no tool call (local model did not force one): ${JSON.stringify(data.message).slice(0, 300)}`,
    );
  }
}
