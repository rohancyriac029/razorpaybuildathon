// Spec §3.4: replayable from the DB. This is that property put to use: the
// production scheduler's onFire dispatcher (src/server.ts) fires with only
// an intentId — everything executeApproved() needs (the effective proposal,
// verdict, contextHash) is re-derived from the `episodes`/`intents` rows
// decide() already wrote, rather than kept in an in-memory closure. That
// means a restart-safe dispatcher is possible even though RealScheduler's
// own timers are not (src/scheduler/real.ts) — the durability gap is
// narrower than it first looks, and closing it fully is "swap RealScheduler
// for BullMQ," not "redesign the dispatcher."
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { PolicyVerdict, Proposal } from "../types.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface RehydratedExecution {
  contextHash: string;
  proposal: Proposal;
  verdict: PolicyVerdict;
}

export function rehydrateForExecution(db: Db, intentId: string): RehydratedExecution | null {
  const intent = db.select({ episodeId: schema.intents.episodeId }).from(schema.intents).where(eq(schema.intents.id, intentId)).get();
  if (!intent) return null;

  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, intent.episodeId)).get();
  if (!episode) return null;

  return {
    contextHash: episode.contextHash,
    proposal: episode.proposal as unknown as Proposal,
    verdict: { kind: episode.verdictKind, ruleId: episode.verdictRuleId, reason: episode.verdictReason },
  };
}
