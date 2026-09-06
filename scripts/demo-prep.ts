#!/usr/bin/env -S npx tsx
// One command to make the dashboard demo-ready.
//
//   npm run demo:prep && npm run dev    # then open http://localhost:3000
//
// Does two things:
//   1. Seeds the live decision beats (terminal trap, normal recovery, P8 race)
//      by running the REAL pipeline — see scripts/seed-demo.ts.
//   2. Copies a finished eval run's `eval_runs` rows into the dev database so
//      the "Eval scoreboard" tab renders real benchmark numbers.
//
// Step 2 exists because the eval writes to its own database (EVAL_DB) while
// the server reads DATABASE_URL, and running the eval directly against the dev
// database is not an option: resetEvalState() clears `orders`/`episodes`, which
// would destroy the decision beats seeded in step 1. Copying only `eval_runs`
// keeps both on screen at once.
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  // no .env — fine, this script needs no credentials
}

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";

const SOURCE = process.env.EVAL_SOURCE_DB ?? "./salvage-pilot3.sqlite";
const TARGET = (process.env.DATABASE_URL ?? "file:./salvage.sqlite").replace(/^file:/, "");

if (!existsSync(SOURCE)) {
  console.error(`[demo-prep] eval source database not found: ${SOURCE}`);
  console.error(`[demo-prep] set EVAL_SOURCE_DB, or run an eval first.`);
  process.exit(1);
}

// Ad-hoc rows from the dashboard's "Run a recovery request" form pile up with
// every rehearsal, and they all look alike (same amount, same shape). Left in
// place they bury the seeded beats — the terminal trap and the P8 race — at the
// bottom of a list the presenter has to scroll on stage. Cleared here so
// demo:prep always yields the same short, legible list. Seeded beats and buyer
// beats are matched by their own id prefixes and are never touched.
console.log("[demo-prep] 0/2 clearing ad-hoc request rows from previous rehearsals...");
{
  const dev = new Database(TARGET);
  dev.pragma("foreign_keys = OFF");
  const ids = dev
    .prepare("SELECT id FROM orders WHERE razorpay_order_id LIKE 'order_demo_request_%'")
    .all() as { id: string }[];
  if (ids.length > 0) {
    const list = ids.map((r) => r.id);
    const holes = list.map(() => "?").join(",");
    const wipe = dev.transaction((orderIds: string[]) => {
      dev.prepare(`DELETE FROM episodes WHERE order_id IN (${holes})`).run(...orderIds);
      dev.prepare(`DELETE FROM intents WHERE order_id IN (${holes})`).run(...orderIds);
      dev.prepare(`DELETE FROM failures WHERE order_id IN (${holes})`).run(...orderIds);
      dev.prepare(`DELETE FROM orders WHERE id IN (${holes})`).run(...orderIds);
    });
    wipe(list);
  }
  dev.pragma("foreign_keys = ON");
  dev.close();
  console.log(`[demo-prep] cleared ${ids.length} ad-hoc request order(s)`);
}

console.log("[demo-prep] 1/2 seeding live decision beats (real pipeline)...");
execFileSync("npx", ["tsx", "scripts/seed-demo.ts"], { stdio: "inherit", shell: process.platform === "win32" });

console.log(`[demo-prep] 2/2 copying eval_runs from ${SOURCE} -> ${TARGET}...`);
const target = new Database(TARGET);
target.pragma("foreign_keys = OFF");

const source = new Database(SOURCE, { readonly: true });
const rows = source.prepare("SELECT * FROM eval_runs").all() as Record<string, unknown>[];
source.close();

if (rows.length === 0) {
  console.error(`[demo-prep] ${SOURCE} has no eval_runs rows — nothing to show on the scoreboard.`);
  process.exit(1);
}

target.prepare("DELETE FROM eval_runs").run();
const columns = Object.keys(rows[0]!);
const insert = target.prepare(
  `INSERT INTO eval_runs (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
);
const insertAll = target.transaction((batch: Record<string, unknown>[]) => {
  for (const row of batch) insert.run(row);
});
insertAll(rows);
target.pragma("foreign_keys = ON");

const strategies = [...new Set(rows.map((r) => String(r.strategy_name)))];
console.log(`[demo-prep] copied ${rows.length} eval rows across ${strategies.length} strategies: ${strategies.join(", ")}`);
target.close();

console.log("\n[demo-prep] ready. Now run:  npm run dev   ->  http://localhost:3000");
console.log("[demo-prep]   Tab 1 'Decisions'       — the live audit trail (terminal trap, P8 race)");
console.log("[demo-prep]   Tab 2 'Eval scoreboard' — the benchmark the agent wins");
