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

// Free-tier gemini-3.5-flash-lite is 30 RPM (verified 2026-09-02, PROGRESS.md
// block 6/8 — re-check before relying on it). AgentStrategy falls back to
// RulesStrategy on ANY thrown error (spec §3.1.1), including a 429 — so
// without throttling here, a real multi-hundred-call eval run would hit
// rate limits partway through and silently replace agent episodes with
// Rules-strategy fallbacks, corrupting the very numbers the eval exists to
// measure. 2.5s between calls is ~24 RPM, comfortably under the cap.
const MIN_INTERVAL_MS = 2_500;
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
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

    // Retries a 429 with backoff — belt-and-braces alongside the throttle
    // above, which should prevent most of these outright. Anything else
    // (4xx/5xx) fails immediately into AgentStrategy's existing
    // Rules-strategy fallback (spec §3.1.1) rather than retrying blindly.
    const RETRY_DELAYS_MS = [5_000, 15_000];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      await throttle();
      const res = await fetch(`${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return this.parseResponse(await res.json());
      }

      const text = await res.text();
      lastError = new Error(`Gemini API error ${res.status}: ${text}`);
      if (res.status !== 429 || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
    throw lastError;
  }

  private parseResponse(data: unknown): LlmCompleteResponse {
    const parsed = data as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const part = parsed.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
    if (!part?.functionCall) {
      throw new Error(`Gemini response contained no function call: ${JSON.stringify(parsed).slice(0, 500)}`);
    }

    return {
      toolCall: {
        id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
        raw: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
      },
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
