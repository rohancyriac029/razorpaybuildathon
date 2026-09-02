// Test double for LlmClient — deterministic, offline testing of
// AgentStrategy's loop mechanics without a real API call. Two modes:
// a fixed queue of tool calls to return in order, or a function that
// inspects the turns so far and decides what to return next (for testing
// reactions to tool results, e.g. the P14 refusal-and-retry path).
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse, LlmToolCall, LlmTurn } from "../../src/llm/client.js";

export class FakeLlmClient implements LlmClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  calls = 0;

  constructor(
    private readonly respond: LlmToolCall[] | ((turns: LlmTurn[], step: number) => LlmToolCall),
  ) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const step = this.calls;
    this.calls++;
    const toolCall = Array.isArray(this.respond) ? this.respond[step] : this.respond(req.turns, step);
    if (!toolCall) throw new Error(`FakeLlmClient: no scripted response for step ${step}`);
    return { toolCall, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
