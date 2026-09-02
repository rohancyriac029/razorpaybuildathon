// Provider-agnostic tool-use interface. [v2.1 deviation, documented in
// PROGRESS.md block 6] Spec §3.2/§6 specify the Anthropic SDK; this build
// runs on Gemini (gemini-3.5-flash-lite) because that's the credential
// available, behind this interface so switching back is a one-line change
// in the strategy's construction, not a rewrite. src/llm/anthropic-client.ts
// implements this too, matching the spec's documented default — but is
// UNTESTED (no Anthropic key to verify against). src/llm/gemini-client.ts
// is the one actually exercised.
//
// Modeled on Anthropic's tool-use shape (forced tool choice, tool_result
// turns fed back into the conversation) since that's the spec's canonical
// interface — the Gemini adapter translates into Gemini's function-calling
// shape, not the other way around.

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07-ish subset both providers accept: type/properties/required/enum). */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
  /**
   * Opaque, provider-specific data a client may need to correctly replay
   * this turn in a later request within the same conversation — e.g.
   * Gemini's `thoughtSignature`, required on replayed functionCall parts
   * for its 3.x model line or the API rejects the request (discovered live,
   * 2026-09-02 — not documented anywhere this build's research turned up).
   * Other providers ignore it.
   */
  raw?: unknown;
}

export type LlmTurn =
  | { role: "assistant"; toolCall: LlmToolCall }
  | { role: "tool_result"; toolCallId: string; toolName: string; content: string };

export interface LlmCompleteRequest {
  systemPrompt: string;
  /** The kickoff message that starts the conversation, before any tool turns. */
  userMessage: string;
  tools: LlmToolDef[];
  turns: LlmTurn[];
}

export interface LlmCompleteResponse {
  toolCall: LlmToolCall; // tool choice is always forced — spec §7: "every response ends with exactly one tool call"
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
