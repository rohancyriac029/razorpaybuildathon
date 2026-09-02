// Single place LLM_PROVIDER is read. Swapping providers (spec's documented
// Anthropic default vs. this build's Gemini deviation, PROGRESS.md block 6)
// is changing this env var, not touching agent-strategy.ts or any tool code.
import { GeminiClient } from "./gemini-client.js";
import { AnthropicClient } from "./anthropic-client.js";
import type { LlmClient } from "./client.js";

export function llmClientFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = env.LLM_PROVIDER ?? "anthropic";

  if (provider === "gemini") {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
    return new GeminiClient(key, env.GEMINI_MODEL ?? "gemini-3.5-flash-lite");
  }

  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    return new AnthropicClient(key);
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}" — expected "gemini" or "anthropic"`);
}
