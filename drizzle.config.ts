import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit (migrations/push) connection.
 *
 * Same rule as the server runtime (src/db/index.ts): the connection comes
 * from the first set variable among DATABASE_URL, POSTGRES_PRISMA_URL,
 * POSTGRES_URL, POSTGRES_URL_NON_POOLING. There is NO localhost/127.0.0.1
 * fallback in production — the local sandbox default below is only for
 * development tooling (NODE_ENV not set / non-production) and is never
 * used when any of the connection variables is present.
 */
const url =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  (process.env.NODE_ENV === "production"
    ? (() => {
        throw new Error(
          "drizzle-kit: a database connection string is required (DATABASE_URL, POSTGRES_PRISMA_URL, POSTGRES_URL or POSTGRES_URL_NON_POOLING). Refusing to fall back to 127.0.0.1:5432 or localhost in production.",
        );
      })()
    : "postgresql://postgres:postgres@127.0.0.1:5432/app_db");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url },
});
