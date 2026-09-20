#!/usr/bin/env node
/**
 * Additive production migration run before `next build`.
 *
 * The project historically used `drizzle-kit push` without checked-in SQL
 * migrations. That allowed application code and an already-populated database
 * to drift apart. Keep release migrations explicit and idempotent here; never
 * infer or destructively rewrite production schema during a deployment.
 *
 * SINGLE SOURCE OF TRUTH — SCHEMA RECONCILER
 * ------------------------------------------
 * A hand-maintained column allow-list is exactly what let the deployed app and
 * the production database drift apart (e.g. `user_sessions.device_label` shipped
 * in src/db/schema.ts but was never added by this script → login failed with
 * SQLSTATE 42703 `column "device_label" does not exist`). To make that class of
 * outage impossible, the reconciler below reads `src/db/schema.ts` — the ONE
 * source of truth every route/lib already imports — and, for every table it
 * declares:
 *   • CREATE TABLE IF NOT EXISTS (only when the table is entirely absent), and
 *   • ADD COLUMN IF NOT EXISTS for every column the live database is missing.
 *
 * It is deliberately ADDITIVE and NON-DESTRUCTIVE:
 *   • It never drops or alters the type of an existing column, never drops a
 *     table, never touches a row's data.
 *   • Every newly added column is created NULLABLE (even where schema.ts marks
 *     it NOT NULL) so adding it to a populated table can never fail. Columns
 *     that must ultimately be NOT NULL are backfilled + tightened explicitly in
 *     the curated data-migration section further down (businesses.owner_id,
 *     expense_categories.owner_id, …), exactly as before.
 *   • Declared defaults ARE applied, so existing rows get a sensible value and
 *     new inserts behave identically to a fresh `drizzle-kit push`.
 * The curated backfill / multi-owner / index / sequence-realignment logic that
 * follows is preserved unchanged — the reconciler only guarantees the columns
 * and tables it depends on physically exist first.
 */
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as appSchema from "../src/db/schema.ts";

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

// ──────────────────────────────────────────────────────────────────────────────
// Schema reconciler helpers (drive DDL from src/db/schema.ts, the single source
// of truth). Pure functions — no I/O — so they are trivially testable.
// ──────────────────────────────────────────────────────────────────────────────

/** Every drizzle pgTable exported by the app schema, as parsed table configs. */
function collectSchemaTables() {
  const tables = [];
  for (const value of Object.values(appSchema)) {
    if (is(value, PgTable)) tables.push(getTableConfig(value));
  }
  return tables;
}

/** Quote a PostgreSQL identifier safely. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Render a column's declared DEFAULT (from schema.ts) as a SQL literal/expression,
 * or null when the column has no usable default. `serial` is excluded — its
 * default is the owning sequence, created by the column type itself.
 */
function renderColumnDefault(col) {
  if (!col.hasDefault) return null;
  if (col.getSQLType() === "serial") return null;
  const def = col.default;
  if (is(def, SQL)) {
    // e.g. sql`now()` / sql`'[]'::jsonb` — concatenate the static string chunks.
    let out = "";
    for (const chunk of def.queryChunks || []) {
      if (chunk && Array.isArray(chunk.value)) out += chunk.value.join("");
      else if (typeof chunk === "string") out += chunk;
      else return null; // a parameterised default is not expected here — skip safely
    }
    out = out.trim();
    return out || null;
  }
  if (def === undefined) return null;
  if (typeof def === "boolean") return def ? "true" : "false";
  if (typeof def === "number") return Number.isFinite(def) ? String(def) : null;
  if (typeof def === "string") return `'${def.replace(/'/g, "''")}'`;
  if (def === null) return "null";
  if (Array.isArray(def) || typeof def === "object") {
    const cast = col.getSQLType() === "jsonb" ? "jsonb" : "json";
    return `'${JSON.stringify(def).replace(/'/g, "''")}'::${cast}`;
  }
  return null;
}

/**
 * Map a drizzle column's SQL type to the concrete type used in ADD COLUMN /
 * CREATE TABLE. `serial` is only a real column type when the column is the
 * table's primary key; elsewhere (it never is in this schema) it degrades to
 * integer. Everything else passes through as drizzle already renders valid
 * PostgreSQL type names (integer, text, boolean, jsonb, timestamp,
 * "double precision").
 */
function columnSqlType(col) {
  return col.getSQLType();
}

/**
 * Build the column clause used inside CREATE TABLE. Primary-key serial columns
 * keep NOT NULL + PRIMARY KEY (their sequence default is implicit). Non-PK
 * columns get their declared default; NOT NULL is applied only when the column
 * also carries a default or is a serial/primary key, so creating a brand-new
 * (empty) table matches drizzle while never emitting an unsatisfiable NOT NULL.
 */
function createTableColumnClause(col) {
  const name = quoteIdent(col.name);
  const type = columnSqlType(col);
  if (col.primary && type === "serial") {
    return `${name} serial primary key`;
  }
  const parts = [name, type === "serial" ? "integer" : type];
  const def = renderColumnDefault(col);
  if (def !== null) parts.push(`default ${def}`);
  if (col.primary) parts.push("primary key");
  // On a freshly created (empty) table NOT NULL is always satisfiable.
  if (col.notNull || col.primary) parts.push("not null");
  return parts.join(" ");
}

/**
 * ADD COLUMN clause for an EXISTING (possibly populated) table. Deliberately
 * NULLABLE regardless of schema.ts's notNull flag — adding a NOT NULL column to
 * a table that already has rows would fail. The declared default is still
 * applied so both existing rows and future inserts get the right value. Columns
 * that must end up NOT NULL are tightened later, after their explicit backfill.
 */
function addColumnClause(col) {
  const type = columnSqlType(col);
  const parts = [quoteIdent(col.name), type === "serial" ? "integer" : type];
  const def = renderColumnDefault(col);
  if (def !== null) parts.push(`default ${def}`);
  return parts.join(" ");
}

/**
 * Reconcile the live database against src/db/schema.ts: create any wholly
 * missing table, and add any missing column to every existing table. Returns a
 * summary of what it changed for the deploy log. Idempotent and additive.
 */
async function reconcileSchema(dbClient) {
  const tables = collectSchemaTables();
  const createdTables = [];
  const addedColumns = [];

  // Which public tables already exist?
  const liveTablesRes = await dbClient.query(
    `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const liveTables = new Set(liveTablesRes.rows.map((r) => r.table_name));

  for (const table of tables) {
    // Only reconcile tables in the default (public) schema.
    if (table.schema && table.schema !== "public") continue;
    const tableName = table.name;

    if (!liveTables.has(tableName)) {
      const cols = table.columns.map(createTableColumnClause).join(",\n  ");
      await dbClient.query(
        `create table if not exists public.${quoteIdent(tableName)} (\n  ${cols}\n)`,
      );
      createdTables.push(tableName);
      liveTables.add(tableName);
      continue; // a just-created table already has every column
    }

    // Existing table → add only the columns it is missing.
    const liveColsRes = await dbClient.query(
      `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
      [tableName],
    );
    const liveCols = new Set(liveColsRes.rows.map((r) => r.column_name));
    for (const col of table.columns) {
      if (liveCols.has(col.name)) continue;
      await dbClient.query(
        `alter table public.${quoteIdent(tableName)} add column if not exists ${addColumnClause(col)}`,
      );
      addedColumns.push(`${tableName}.${col.name}`);
    }
  }

  return { createdTables, addedColumns };
}

/**
 * Create every index/unique constraint declared in schema.ts that does not yet
 * exist (matched by index name). Idempotent via `IF NOT EXISTS`; a unique index
 * that already exists on a populated table is a no-op, and no data is touched.
 * Complements the curated performance indexes created later in this script.
 */
async function reconcileIndexes(dbClient) {
  const tables = collectSchemaTables();
  const createdIndexes = [];
  const liveIdxRes = await dbClient.query(
    `select indexname from pg_indexes where schemaname = 'public'`,
  );
  const liveIdx = new Set(liveIdxRes.rows.map((r) => r.indexname));

  for (const table of tables) {
    if (table.schema && table.schema !== "public") continue;
    for (const idx of table.indexes || []) {
      const cfg = idx.config || {};
      const name = cfg.name;
      const cols = (cfg.columns || [])
        .map((c) => c?.name)
        .filter(Boolean);
      if (!name || cols.length === 0) continue; // skip expression indexes we can't safely render
      if (liveIdx.has(name)) continue;
      const unique = cfg.unique ? "unique " : "";
      const colList = cols.map(quoteIdent).join(", ");
      await dbClient.query(
        `create ${unique}index if not exists ${quoteIdent(name)} on public.${quoteIdent(table.name)} (${colList})`,
      );
      createdIndexes.push(name);
      liveIdx.add(name);
    }
  }
  return { createdIndexes };
}

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

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 1 — Schema reconciler (schema.ts is the single source of truth).
  //
  // Create any missing table and add EVERY missing column across all tables,
  // additively and idempotently. This replaces the previous hand-maintained
  // per-column allow-lists (which is what silently dropped user_sessions'
  // device_label / user_agent / ip_hash / initial_business_id and caused the
  // production 42703 login failure). New columns are added NULLABLE with their
  // declared default; the curated STEP 2 below backfills and, only where safe,
  // tightens the specific columns that must be NOT NULL.
  // ──────────────────────────────────────────────────────────────────────────────
  const { createdTables, addedColumns } = await reconcileSchema(client);
  if (createdTables.length) {
    console.log(`[db:migrate] created missing tables: ${createdTables.join(", ")}`);
  }
  if (addedColumns.length) {
    console.log(`[db:migrate] added missing columns: ${addedColumns.join(", ")}`);
  }
  const { createdIndexes } = await reconcileIndexes(client);
  if (createdIndexes.length) {
    console.log(`[db:migrate] created missing indexes: ${createdIndexes.join(", ")}`);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 2 — Curated data migration (multi-owner backfill, targeted NOT NULL
  // tightening, indexes, per-org singletons, sequence realignment). Unchanged;
  // it now runs against a schema guaranteed to have every required column.
  // ──────────────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────────────
  // Performance indexes (additive; IF NOT EXISTS ⇒ idempotent). These serve the
  // hot access paths: per-business scoping in /api/init & module queries and the
  // per-organization tenant filters. Read-only accelerator — zero data change.
  // ──────────────────────────────────────────────────────────────────────────────
  const perfIndexes = [
    ["customers", "business_id"], ["customers", "owner_id"],
    ["credit_sales", "business_id"],
    ["employees", "business_id"],
    ["assets", "business_id"],
    ["inventory_items", "business_id"],
    ["transactions", "business_id"],
    ["business_metrics", "business_id"],
    ["suppliers", "owner_id"],
    ["integrations", "owner_id"],
    ["ai_insights", "business_id"], ["ai_insights", "owner_id"],
    ["scenario_simulations", "target_business_id"], ["scenario_simulations", "owner_id"],
    ["checklist_templates", "business_id"], ["checklist_entries", "business_id"],
    ["poultry_logs", "business_id"], ["block_factory_logs", "business_id"],
    ["aquaculture_logs", "business_id"], ["livestock_logs", "business_id"],
    ["restaurant_logs", "business_id"], ["electronics_logs", "business_id"],
    ["car_wash_logs", "business_id"], ["hardware_logs", "business_id"],
    ["organization_members", "organization_id"], ["organization_members", "user_id"],
    ["user_sessions", "user_id"],
    ["audit_trail", "owner_id"],
  ];
  for (const [tbl, col] of perfIndexes) {
    const t = await client.query("select to_regclass($1) as name", [`public.${tbl}`]);
    if (t.rows[0]?.name) {
      await client.query(
        `create index if not exists ${tbl}_${col}_idx on public.${tbl} (${col})`,
      );
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
  const changeSummary =
    createdTables.length || addedColumns.length || createdIndexes.length
      ? `reconciled schema (+${createdTables.length} table(s), +${addedColumns.length} column(s), +${createdIndexes.length} index(es))`
      : "schema already in sync";
  console.log(
    `[db:migrate] ${changeSummary} via ${dbUrlEnv} (${describeTarget()})`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error("[db:migrate] failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
