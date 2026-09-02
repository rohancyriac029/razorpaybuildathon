// Spec §5.8: "Cache LLM responses and commit the cache so a reviewer
// reproduces your table without an API key." Cache key includes `seed` —
// deliberately, because keying only on the request would collapse the
// eval's 3 independent seeds onto the same cached response, silently
// reporting zero variance and defeating the entire point of running
// multiple seeds (spec's own §5.8 flags this exact conflict).
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse } from "./client.js";

type Db = BetterSQLite3Database<typeof schema>;

export function cacheKey(model: string, req: LlmCompleteRequest, seed: number): string {
  const stable = JSON.stringify({
    model,
    systemPrompt: req.systemPrompt,
    userMessage: req.userMessage,
    tools: req.tools.map((t) => t.name), // tool set identity, not full schemas — schemas don't change within a build
    turns: req.turns,
    seed,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export class CachingLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly db: Db,
    private readonly seed: number = 0,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }
  get model(): string {
    return this.inner.model;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const key = cacheKey(this.inner.model, req, this.seed);

    const cached = this.db.select().from(schema.llmCache).where(eq(schema.llmCache.cacheKey, key)).get();
    if (cached) {
      return cached.response as unknown as LlmCompleteResponse;
    }

    const response = await this.inner.complete(req);
    this.db
      .insert(schema.llmCache)
      .values({ cacheKey: key, response: response as unknown as object, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    return response;
  }
}
