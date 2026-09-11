import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

/**
 * Load local Next.js-style env files when drizzle-kit is run by hand.
 * Existing shell/CI variables keep priority because dotenv does not override
 * them. Production commands should pass DATABASE_URL explicitly so the target
 * database is unambiguous.
 */
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

/**
 * drizzle-kit (migrations/push) connection.
 *
 * Keep this resolution order identical to the server runtime
 * (src/db/index.ts). There is deliberately NO implicit localhost fallback:
 * without a configured URL, `drizzle-kit push` must stop rather than report
 * "No changes detected" for an unrelated local database while production is
 * still missing its auth schema.
 */
const url =
  process.env.DATABASE_URL?.trim() ||
  process.env.POSTGRES_PRISMA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  process.env.POSTGRES_URL_NON_POOLING?.trim();

if (!url) {
  throw new Error(
    "drizzle-kit: no database connection string is configured. Set DATABASE_URL (or POSTGRES_PRISMA_URL / POSTGRES_URL / POSTGRES_URL_NON_POOLING) to the exact database you intend to update. Example: DATABASE_URL=\"<managed-production-url>\" npx drizzle-kit push. Refusing to use an implicit localhost database.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url },
});
