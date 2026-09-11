#!/usr/bin/env node
/**
 * Small, additive production migration run before `next build`.
 *
 * The project historically used `drizzle-kit push` without checked-in SQL
 * migrations. That allowed application code and an already-populated database
 * to drift apart. Keep release migrations explicit and idempotent here; never
 * infer or destructively rewrite production schema during a deployment.
 */
import { config as loadEnv } from "dotenv";
import pg from "pg";

const { Client } = pg;

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const DB_URL_ENV_NAMES = [
  "DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
];
const dbUrlEnv = DB_URL_ENV_NAMES.find((name) => process.env[name]?.trim());

// Building without a database is intentionally supported. Runtime health will
// report the missing configuration; a build must not silently use localhost.
if (!dbUrlEnv) {
  console.log("[db:migrate] skipped: no database URL is configured (no localhost fallback)");
  process.exit(0);
}

const connectionString = process.env[dbUrlEnv].trim();
const describeTarget = () => {
  try {
    const url = new URL(connectionString.replace(/^postgres(ql)?:\/\//i, "https://"));
    return `host=${url.hostname} database=${url.pathname.replace(/^\//, "")}`;
  } catch {
    return "host=<unparsable>";
  }
};

const client = new Client({
  connectionString,
  ssl:
    process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : process.env.PGSSLMODE === "disable"
        ? false
        : undefined,
});

try {
  await client.connect();
  await client.query("begin");
  // Concurrent Vercel builds must serialize this additive DDL.
  await client.query("select pg_advisory_xact_lock(hashtext('gomina360-production-schema'))");

  const table = await client.query("select to_regclass('public.users') as name");
  if (!table.rows[0]?.name) {
    throw new Error(
      "The users table does not exist. Apply the full schema first with DATABASE_URL=\"<managed-url>\" npx drizzle-kit push.",
    );
  }

  const before = await client.query(`
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'can_delete_inventory'
  `);

  await client.query(`
    alter table public.users
      add column if not exists can_delete_inventory boolean default false
  `);

  await client.query("commit");
  console.log(
    `[db:migrate] ${before.rowCount ? "verified" : "applied"} users.can_delete_inventory via ${dbUrlEnv} (${describeTarget()})`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error("[db:migrate] failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
