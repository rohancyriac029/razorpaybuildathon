// Spec §5.8: "Cache LLM responses and commit the cache so a reviewer
// reproduces your table without an API key." Cache key includes `seed` —
// deliberately, because keying only on the request would collapse the
// eval's 3 independent seeds onto the same cached response, silently
// reporting zero variance and defeating the entire point of running
// multiple seeds (spec's own §5.8 flags this exact conflict).
//
// Also includes `episodeKey`, added after a real bug caught by re-running
// the CLI twice against a persisted DB (PROGRESS.md block 8): the FIRST
// call of every episode has identical empty `turns` and the same fixed
// kickoff message, so without an episode-scoping component, two different
// scenarios' first calls hash to the SAME key and silently share one
// cached response — the second scenario never gets its own real answer.
// One CachingLlmClient instance must be constructed per episode (not
// shared across a whole seed's worth of scenarios) so this key actually
// discriminates from the very first call onward.
//
// Known, accepted residual: within ONE scenario, if it takes multiple
// attempts (spec §3's multi-attempt trajectory), each attempt's FIRST call
// still collides with the others (episodeKey doesn't include attemptNumber
// — plumbing it through would mean reconstructing AgentStrategy per
// attempt inside run-episode.ts's loop, not just per scenario). Low
// impact, not zero: the system prompt hard-requires "call getFailureContext
// first, always," so the first call's actual decision is invariant across
// attempts regardless of context — the shared cached response is the
// correct one to reuse either way. Left as a documented limitation rather
// than a silent one.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { LlmClient, LlmCompleteRequest, LlmCompleteResponse } from "./client.js";

type Db = BetterSQLite3Database<typeof schema>;

export function cacheKey(model: string, req: LlmCompleteRequest, seed: number, episodeKey: string): string {
  const stable = JSON.stringify({
    model,
    episodeKey,
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
    private readonly seed: number,
    private readonly episodeKey: string,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }
  get model(): string {
    return this.inner.model;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const key = cacheKey(this.inner.model, req, this.seed, this.episodeKey);

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
