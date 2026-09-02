// Spec §6 block 2: src/policy/engine.ts. The concrete PolicyEngine the rest
// of the system depends on via the port (src/ports/policy-engine.ts).
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { PolicyEngine, PolicyContext } from "../ports/policy-engine.js";
import type { PolicyVerdict, Proposal } from "../types.js";
import { evaluateProposal, DEFAULT_POLICY_CONFIG, type PolicyConfig } from "./rules.js";
import { gatherSnapshot } from "./gather-snapshot.js";

type Db = BetterSQLite3Database<typeof schema>;

export function policyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  return {
    killSwitch: env.KILL_SWITCH === "true",
    globalExecPerHour: Number(env.GLOBAL_EXEC_PER_HOUR ?? DEFAULT_POLICY_CONFIG.globalExecPerHour),
    globalContactsPerDay: Number(env.GLOBAL_CONTACTS_PER_DAY ?? DEFAULT_POLICY_CONFIG.globalContactsPerDay),
    stalenessCutoffDays: Number(env.STALENESS_CUTOFF_DAYS ?? DEFAULT_POLICY_CONFIG.stalenessCutoffDays),
    valueCeilingPaise: Number(env.VALUE_CEILING_PAISE ?? DEFAULT_POLICY_CONFIG.valueCeilingPaise),
  };
}

export class RulesPolicyEngine implements PolicyEngine {
  constructor(
    private readonly db: Db,
    private readonly config: PolicyConfig = DEFAULT_POLICY_CONFIG,
  ) {}

  async decide(proposal: Proposal, ctx: PolicyContext): Promise<PolicyVerdict> {
    const snapshot = gatherSnapshot(this.db, proposal.orderId, proposal, ctx.now);
    return evaluateProposal(proposal, ctx, snapshot, this.config);
  }
}
