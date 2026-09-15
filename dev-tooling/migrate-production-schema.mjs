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

  // ──────────────────────────────────────────────────────────────────────────────
  // Multi-Owner upgrade (additive, idempotent, backfilled — mirrors
  // dev-tooling/migrate-multiowner.mjs). Creates the Organization layer and the
  // tenant ownership columns without touching any existing row's meaning.
  // ──────────────────────────────────────────────────────────────────────────────
  await client.query(`create table if not exists public.organizations (
      id serial primary key,
      name text not null,
      slug text not null,
      status text not null default 'ACTIVE',
      contact_email text,
      contact_phone text,
      owner_user_id integer,
      created_by_user_id integer,
      created_at timestamp default now(),
      updated_at timestamp default now()
    )`);
  await client.query(`create unique index if not exists organizations_slug_uq on public.organizations (slug)`);
  await client.query(`create table if not exists public.organization_members (
      id serial primary key,
      organization_id integer not null,
      user_id integer not null,
      role_in_org text not null default 'MEMBER',
      is_primary boolean default true,
      created_at timestamp default now()
    )`);
  await client.query(`create unique index if not exists organization_members_org_user_uq2 on public.organization_members (organization_id, user_id)`);

  const columnAdds = [
    ["public.users", "is_super_admin", "boolean default false"],
    ["public.users", "primary_org_id", "integer"],
    ["public.businesses", "owner_id", "integer"],
    ["public.customers", "owner_id", "integer"],
    ["public.suppliers", "owner_id", "integer"],
    ["public.integrations", "owner_id", "integer"],
    ["public.ai_insights", "owner_id", "integer"],
    ["public.scenario_simulations", "owner_id", "integer"],
    ["public.notifications", "owner_id", "integer"],
    ["public.audit_trail", "owner_id", "integer"],
    ["public.universal_exports", "owner_id", "integer"],
    ["public.record_deletion_logs", "owner_id", "integer"],
    ["public.asset_audit_logs", "owner_id", "integer"],
    ["public.asset_downloads", "owner_id", "integer"],
    ["public.inventory_downloads", "owner_id", "integer"],
    ["public.expense_categories", "owner_id", "integer"],
    ["public.company_settings", "organization_id", "integer"],
    ["public.customer_support_info", "organization_id", "integer"],
    ["public.payroll_statutory_config", "organization_id", "integer"],
    // Feature 3 — per-Owner Allowed Business Types (additive; default FALSE ⇒
    // every pre-existing organization keeps access to all current & future types).
    ["public.organizations", "business_types_restricted", "boolean default false"],
  ];
  for (const [tbl, col, def] of columnAdds) {
    const t = await client.query("select to_regclass($1) as name", [tbl]);
    if (t.rows[0]?.name) {
      await client.query(`alter table ${tbl} add column if not exists ${col} ${def}`);
    }
  }

  // ── Backfill: single existing Owner ⇒ org #1 owns everything it does today ──
  await client.query(`insert into public.organizations (id, name, slug, status, contact_email, owner_user_id, created_by_user_id)
      select 1, 'GoMina Group', 'gomina-group', 'ACTIVE', 'kwame.owner@gomina360.com', 1, 1
      where not exists (select 1 from public.organizations where id = 1)`);
  await client.query(`update public.users set is_super_admin = true where id = 1 and (is_super_admin is distinct from true)`);
  await client.query(`update public.users set primary_org_id = 1 where primary_org_id is null`);
  await client.query(`insert into public.organization_members (organization_id, user_id, role_in_org, is_primary)
      select 1, id, case when role = 'OWNER' then 'OWNER' else 'MEMBER' end, true from public.users
      on conflict (organization_id, user_id) do nothing`);
  await client.query(`update public.organizations set owner_user_id = 1, updated_at = now() where id = 1 and owner_user_id is null`);

  await client.query(`update public.businesses set owner_id = 1 where owner_id is null`);
  await client.query(`alter table public.businesses alter column owner_id set not null`);
  await client.query(`create index if not exists businesses_owner_id_idx on public.businesses (owner_id)`);

  // Allowed Business Types allowlist (matters only when an org's
  // business_types_restricted flag is true).
  await client.query(`create table if not exists public.organization_business_types (
      id serial primary key,
      organization_id integer not null references public.organizations(id),
      business_type_key text not null,
      created_by_user_id integer,
      created_at timestamp default now()
    )`);
  await client.query(`create unique index if not exists organization_business_types_org_type_uq on public.organization_business_types (organization_id, business_type_key)`);

  // businessId-anchored audit/download tables (join backfill, then org-1 default)
  for (const [t, col] of [
    ["asset_downloads", "downloader_business_id"],
    ["inventory_downloads", "downloader_business_id"],
  ]) {
    await client.query(`update public.${t} x set owner_id = b.owner_id from public.businesses b
        where x.${col} = b.id and x.owner_id is null`);
    await client.query(`update public.${t} set owner_id = 1 where owner_id is null`);
  }
  await client.query(`update public.record_deletion_logs set owner_id = 1 where owner_id is null`);
  await client.query(`update public.record_deletion_logs r set owner_id = b.owner_id
      from public.businesses b
      where (r.record_snapshot->>'businessId')::int = b.id and r.owner_id = 1`);
  await client.query(`update public.asset_audit_logs a set owner_id = b.owner_id
      from public.assets, public.businesses b
      where a.asset_id = assets.id and assets.business_id = b.id and a.owner_id is null`);
  await client.query(`update public.asset_audit_logs set owner_id = 1 where owner_id is null`);

  // nullable-businessId business tables
  await client.query(`update public.customers x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.customers set owner_id = 1 where owner_id is null`);
  await client.query(`update public.ai_insights x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.ai_insights set owner_id = 1 where owner_id is null`);
  await client.query(`update public.notifications x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.notifications set owner_id = 1 where owner_id is null`);
  await client.query(`update public.notifications n set owner_id = ou.primary_org_id from public.users ou
      where n.user_id = ou.id and n.owner_id is null`);
  await client.query(`update public.universal_exports x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.universal_exports x set owner_id = u.primary_org_id from public.users u
      where x.requester_user_id = u.id and x.owner_id is null`);
  await client.query(`update public.universal_exports set owner_id = 1 where owner_id is null`);
  await client.query(`update public.audit_trail x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.audit_trail x set owner_id = u.primary_org_id from public.users u
      where x.actor_user_id = u.id and x.owner_id is null`);
  await client.query(`update public.audit_trail set owner_id = 1 where owner_id is null`);

  // globally-shared business directories become org-1 directories
  for (const t of ["suppliers", "integrations", "scenario_simulations"]) {
    await client.query(`update public.${t} set owner_id = 1 where owner_id is null`);
  }
  await client.query(`update public.expense_categories x set owner_id = b.owner_id from public.businesses b
      where x.business_id = b.id and x.owner_id is null`);
  await client.query(`update public.expense_categories set owner_id = 1 where owner_id is null`);
  await client.query(`alter table public.expense_categories alter column owner_id set not null`);

  // singleton settings become per-org rows (existing row = org 1)
  for (const t of ["company_settings", "customer_support_info", "payroll_statutory_config"]) {
    await client.query(`update public.${t} set organization_id = 1 where organization_id is null`);
  }
  await client.query(`create unique index if not exists company_settings_org_uq on public.company_settings (organization_id)`);
  await client.query(`create unique index if not exists customer_support_info_org_uq on public.customer_support_info (organization_id)`);
  await client.query(`create unique index if not exists payroll_statutory_config_org_uq on public.payroll_statutory_config (organization_id)`);

  for (const t of ["customers","suppliers","integrations","ai_insights","scenario_simulations",
                   "notifications","audit_trail","universal_exports","record_deletion_logs",
                   "asset_audit_logs","asset_downloads","inventory_downloads","expense_categories"]) {
    await client.query(`create index if not exists ${t}_owner_id_idx on public.${t} (owner_id)`);
  }

  // Serial realignment sweep: seeded explicit-id rows desynchronise a serial
  // sequence (they bypass nextval), so the next runtime INSERT collides.
  // Realign EVERY public serial sequence against its table's live max(id).
  {
    const tables = await client.query(
      `select t.relname as table_name
         from pg_class t join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relkind = 'r'`,
    );
    for (const { table_name } of tables.rows) {
      const seq = await client.query(`select pg_get_serial_sequence($1, 'id') as s`, [`public.${table_name}`]);
      const s = seq.rows[0]?.s;
      if (s) {
        const short = s.startsWith("public.") ? s.slice(7) : s;
        // Empty table ⇒ is_called must be FALSE (the first real row takes 1);
        // setval(seq, 1, true) on an empty table makes the next insert skip 1.
        await client.query(
          `select setval('${short.replace(/'/g, "''")}',
             (select coalesce(max(id),1) from public.${table_name}),
             (select count(*) > 0 from public.${table_name}))`,
        );
      }
    }
  }

  // Multi-owner runtime tools (used by dev-tooling/multiowner-verify.mjs):
  await client.query(`create or replace function gomina_org_of_business(bid integer)
      returns integer language sql stable as
      'select owner_id from public.businesses where id = bid'`);

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
