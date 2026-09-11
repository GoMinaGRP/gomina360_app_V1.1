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

  // Keep this list aligned with every additive users column in src/db/schema.ts.
  // Foundational NOT NULL identity columns (id, name, email, role, phone) are
  // intentionally excluded: a database without those requires the full schema.
  const userColumns = [
    ["assigned_business_id", "integer"],
    ["avatar_url", "text"],
    ["region", "text"],
    ["district", "text"],
    ["town", "text"],
    ["is_active", "boolean default true"],
    ["is_worker_enabled", "boolean default true"],
    ["created_by_user_id", "integer"],
    ["can_record_sales", "boolean default true"],
    ["can_record_expenses", "boolean default false"],
    ["can_manage_stock", "boolean default false"],
    ["can_export_data", "boolean default false"],
    ["can_manage_records", "boolean default false"],
    ["can_delete_inventory", "boolean default false"],
    ["can_manage_expenses", "boolean default false"],
    ["can_manage_users", "boolean default false"],
    ["can_manage_cctv", "boolean default false"],
    ["can_manage_auditors", "boolean default false"],
    ["can_manage_online", "boolean default false"],
    ["can_create_business", "boolean default false"],
    ["can_view_finance", "boolean default false"],
    ["can_manage_support", "boolean default false"],
    ["business_manage_ids", "jsonb"],
    ["password_hash", "text"],
    ["password_changed_at", "timestamp"],
    ["failed_login_attempts", "integer default 0"],
    ["locked_until", "timestamp"],
    ["access_revoked_at", "timestamp"],
    ["created_at", "timestamp default now()"],
  ];

  const existing = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
  `);
  const existingNames = new Set(existing.rows.map((row) => row.column_name));
  const missingNames = userColumns
    .filter(([name]) => !existingNames.has(name))
    .map(([name]) => name);

  for (const [name, definition] of userColumns) {
    await client.query(
      `alter table public.users add column if not exists ${name} ${definition}`,
    );
  }

  await client.query("commit");
  console.log(
    `[db:migrate] ${missingNames.length ? `applied users.${missingNames.join(", users.")}` : "verified all users columns"} via ${dbUrlEnv} (${describeTarget()})`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error("[db:migrate] failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
