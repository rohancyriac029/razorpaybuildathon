// In-memory SQLite, schema applied from the committed migration in
// drizzle/0000_*.sql — the same file a reviewer's `npm run db:push` (or a
// future `db:migrate`) applies. Tests exercise the real schema, not a
// hand-maintained parallel one that can drift from it.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../src/db/schema.js";

export function makeTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const dir = "drizzle";
  const migrationFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
  for (const file of migrationFiles) {
    const sql = readFileSync(file, "utf-8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  return drizzle(sqlite, { schema });
}
