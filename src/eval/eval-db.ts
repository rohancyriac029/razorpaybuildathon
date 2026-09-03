// A dedicated, file-backed SQLite database for eval runs — separate from
// the dev/demo salvage.sqlite so a full eval run never intermixes with
// production-shaped data. Self-bootstrapping (applies the committed
// migration on first use) so `npm run eval` works without a manual
// `db:push` step first. Deliberately does NOT wipe an existing file: the
// `llm_cache` table living in this same database is exactly what spec
// §5.8 wants committed and reused across runs — recreating the file each
// time would destroy the reproducibility that's the entire point.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

export function makeEvalDb(path: string) {
  const isNew = !existsSync(path);
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  if (isNew) {
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
  }

  return drizzle(sqlite, { schema });
}
