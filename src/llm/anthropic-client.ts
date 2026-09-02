// Spec's documented default provider (§3.2, §6). UNTESTED: this build has
// no ANTHROPIC_API_KEY (PROGRESS.md block 6). Built from the well-documented
// Messages API tool-use shape, not guessed at random, but never exercised
// against a live response — do not claim this works until it's actually
// run once against a real key. Swap LLM_PROVIDER=anthropic in .env and this
// becomes the active client with no other code changes (see src/agent/
// agent-strategy.ts's provider selection).
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse, LlmToolDef, LlmTurn } from "./client.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  text?: string;
}
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(userMessage: string, turns: LlmTurn[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [{ role: "user", content: userMessage }];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: turn.toolCall.id, name: turn.toolCall.name, input: turn.toolCall.input }],
      });
    } else {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: turn.toolCallId, content: turn.content }],
      });
    }
  }
  return messages;
}

function toAnthropicTools(tools: LlmToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

export class AnthropicClient implements LlmClient {
  readonly provider = "anthropic";
  constructor(
    private readonly apiKey: string,
    readonly model: string = "claude-opus-5",
    private readonly maxTokens: number = 2048,
  ) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system: req.systemPrompt,
        messages: toAnthropicMessages(req.userMessage, req.turns),
        tools: toAnthropicTools(req.tools),
        tool_choice: { type: "any" }, // forces a tool call — spec §7
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      content: AnthropicContentBlock[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const toolUse = data.content.find((b) => b.type === "tool_use");
    if (!toolUse?.name || !toolUse.id) {
      throw new Error(`Anthropic response contained no tool_use block: ${JSON.stringify(data).slice(0, 500)}`);
    }

    return {
      toolCall: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  }
}
