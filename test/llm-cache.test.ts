import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { CachingLlmClient } from "../src/llm/cache.js";
import { FakeLlmClient } from "./helpers/fake-llm-client.js";
import type { LlmCompleteRequest } from "../src/llm/client.js";

function kickoffRequest(): LlmCompleteRequest {
  return {
    systemPrompt: "system",
    userMessage: "A payment has failed. Investigate using your tools, then propose exactly one action.",
    tools: [{ name: "getFailureContext", description: "d", inputSchema: {} }],
    turns: [], // identical for every episode's first call — this is the bug's root cause
  };
}

describe("CachingLlmClient episode scoping (regression test for the collision bug)", () => {
  it("two different episodeKeys with identical (empty-turns) requests do NOT share a cached response", async () => {
    const db = makeTestDb();
    let callCount = 0;
    const inner = new FakeLlmClient(() => {
      callCount++;
      return { id: `call_${callCount}`, name: "getFailureContext", input: {} };
    });

    const clientForScenarioA = new CachingLlmClient(inner, db, 1, "scenario_A");
    const clientForScenarioB = new CachingLlmClient(inner, db, 1, "scenario_B");

    await clientForScenarioA.complete(kickoffRequest());
    await clientForScenarioB.complete(kickoffRequest());

    // Before the fix, both calls hashed to the same key and the SECOND
    // would have been served from the cache without ever reaching `inner`.
    expect(callCount).toBe(2);
  });

  it("the SAME episodeKey with an identical request IS served from cache on the second call", async () => {
    const db = makeTestDb();
    let callCount = 0;
    const inner = new FakeLlmClient(() => {
      callCount++;
      return { id: `call_${callCount}`, name: "getFailureContext", input: {} };
    });

    const client = new CachingLlmClient(inner, db, 1, "scenario_A");
    const first = await client.complete(kickoffRequest());
    const second = await client.complete(kickoffRequest());

    expect(callCount).toBe(1); // second call hit the cache
    expect(second.toolCall.id).toBe(first.toolCall.id); // literally the same cached response
  });

  it("different seeds for the same episodeKey do NOT share a cached response (spec §5.8)", async () => {
    const db = makeTestDb();
    let callCount = 0;
    const inner = new FakeLlmClient(() => {
      callCount++;
      return { id: `call_${callCount}`, name: "getFailureContext", input: {} };
    });

    const seed1 = new CachingLlmClient(inner, db, 1, "scenario_A");
    const seed2 = new CachingLlmClient(inner, db, 2, "scenario_A");

    await seed1.complete(kickoffRequest());
    await seed2.complete(kickoffRequest());

    expect(callCount).toBe(2);
  });
});
