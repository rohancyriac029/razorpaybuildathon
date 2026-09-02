// Real, tested LLM client for this build. Verified live 2026-09-02:
// gemini-3.5-flash-lite, real key, real function-calling response
// confirmed via direct API call before this file was written.
//
// Gemini's REST API (v1beta generateContent) is called directly rather than
// through a Google SDK — the surface needed (systemInstruction, tools,
// forced function calling, functionResponse turns) is small and stable
// enough that a dependency wasn't worth it for a hackathon-scope build.
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse, LlmToolDef, LlmTurn } from "./client.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Gemini's function-declaration schema uses UPPERCASE type names
// (OBJECT/STRING/...); our tool defs are written in standard lowercase
// JSON Schema. Translate recursively rather than hand-write two copies of
// every tool schema.
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "type" && typeof value === "string") {
        out[key] = value.toUpperCase();
      } else {
        out[key] = toGeminiSchema(value);
      }
    }
    return out;
  }
  return schema;
}

function toGeminiTools(tools: LlmToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.inputSchema),
      })),
    },
  ];
}

interface GeminiPart {
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
  // Sibling of functionCall, not nested inside it. Required on replayed
  // functionCall parts for the 3.x model line (see client.ts's LlmToolCall.raw
  // doc) or the API returns 400 INVALID_ARGUMENT.
  thoughtSignature?: string;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function toGeminiContents(userMessage: string, turns: LlmTurn[]): GeminiContent[] {
  // The kickoff turn is plain text, not a function part, so it isn't shaped
  // like GeminiPart (which only ever carries functionCall/functionResponse
  // in this file) — cast narrowly at the one call site that needs it.
  const kickoff = { role: "user" as const, parts: [{ text: userMessage } as unknown as GeminiPart] };
  const contents: GeminiContent[] = [kickoff];

  for (const turn of turns) {
    if (turn.role === "assistant") {
      const thoughtSignature = (turn.toolCall.raw as { thoughtSignature?: string } | undefined)?.thoughtSignature;
      contents.push({
        role: "model",
        parts: [{ functionCall: { name: turn.toolCall.name, args: turn.toolCall.input }, thoughtSignature }],
      });
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(turn.content);
      } catch {
        parsed = { result: turn.content };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name: turn.toolName, response: parsed } }] });
    }
  }
  return contents;
}

export class GeminiClient implements LlmClient {
  readonly provider = "gemini";
  constructor(
    private readonly apiKey: string,
    readonly model: string = "gemini-3.5-flash-lite",
  ) {}

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: toGeminiContents(req.userMessage, req.turns),
      tools: toGeminiTools(req.tools),
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    };

    const res = await fetch(`${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
    if (!part?.functionCall) {
      throw new Error(`Gemini response contained no function call: ${JSON.stringify(data).slice(0, 500)}`);
    }

    return {
      toolCall: {
        id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
        raw: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
      },
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
