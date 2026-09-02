import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: (process.env.DATABASE_URL ?? "file:./salvage.sqlite").replace(/^file:/, ""),
  },
} satisfies Config;
