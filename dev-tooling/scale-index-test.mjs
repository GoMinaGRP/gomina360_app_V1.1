#!/usr/bin/env node
/**
 * scale-index-test.mjs — measures the cost of the app's hot read shapes on a
 * production-sized dataset, with and without the composite indexes that
 * dev-tooling/migrate-perf-indexes.mjs adds.
 *
 * The dev database has ~40 transactions, so an EXPLAIN on it proves nothing.
 * This builds a throwaway database `app_scale` with the REAL column types of the
 * hot tables, loads 100k–400k synthetic rows, and EXPLAIN (ANALYZE, BUFFERS)
 * each query shape before/after the index. It never touches app_db.
 */
import { createRequire } from "node:module";
const pg = createRequire("/home/user/pgtooling/package.json")("pg");

const ADMIN = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const SRC = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const DST = "postgresql://postgres:postgres@127.0.0.1:5432/app_scale";
const NBUS = 30; // businesses in the fixture (real orgs grow past 11 units)

// query shapes taken from the routes (business_id IN (...) is what batchRead emits)
const SHAPES = [
  {
    name: "transactions  b_id IN (30) ORDER BY id DESC LIMIT 2001",
    sql: `SELECT * FROM transactions WHERE business_id = ANY($1) ORDER BY id DESC LIMIT 2001`,
    args: [range(1, NBUS)],
    index: `create index if not exists transactions_business_id_id_idx on transactions (business_id, id desc)`,
  },
  {
    name: "audit_trail   b_id IN (30) ORDER BY id DESC LIMIT 500",
    sql: `SELECT * FROM audit_trail WHERE business_id = ANY($1) ORDER BY id DESC LIMIT 500`,
    args: [range(1, NBUS)],
    index: `create index if not exists audit_trail_business_id_id_idx on audit_trail (business_id, id desc)`,
  },
  {
    name: "checklist_entries b_id IN (30) ORDER BY id DESC LIMIT 240",
    sql: `SELECT * FROM checklist_entries WHERE business_id = ANY($1) ORDER BY id DESC LIMIT 240`,
    args: [range(1, NBUS)],
    index: `create index if not exists checklist_entries_business_id_id_idx on checklist_entries (business_id, id desc)`,
  },
  {
    name: "notifications user_id = N ORDER BY id DESC LIMIT 60",
    sql: `SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 60`,
    args: [3],
    index: `create index if not exists notifications_user_id_id_desc_idx on notifications (user_id, id desc)`,
  },
  {
    name: "audit_trail   PLATFORM-WIDE ORDER BY id DESC LIMIT 3000 (super-admin)",
    sql: `SELECT * FROM audit_trail ORDER BY id DESC LIMIT 3000`,
    args: [],
    index: `create index if not exists audit_trail_id_desc_idx on audit_trail (id desc)`,
  },
];

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

async function columnsOf(client, table) {
  const r = await client.query(
    `select column_name, data_type, udt_name, character_maximum_length, is_nullable, column_default
       from information_schema.columns
      where table_schema='public' and table_name=$1
      order by ordinal_position`,
    [table]
  );
  return r.rows;
}

function ddlFor(table, cols) {
  const defs = cols.map((c) => {
    let t = c.data_type;
    if (t === "character varying" && c.character_maximum_length) t = `varchar(${c.character_maximum_length})`;
    if (t === "timestamp with time zone") t = "timestamptz";
    if (t === "double precision") t = "double precision";
    const nn = c.is_nullable === "NO" ? " not null" : "";
    return `  "${c.column_name}" ${t}${nn}`;
  });
  // keep the id sequence behaviour of the real tables
  defs.unshift(`  id serial primary key`);
  return `create table ${table} (\n${defs.join(",\n")}\n)`;
}

const db = new pg.Client({ connectionString: ADMIN });
await db.connect();
await db.query(`drop database if exists app_scale`);
await db.query(`create database app_scale`);
await db.end();

const src = new pg.Client({ connectionString: SRC });
await src.connect();
const dst = new pg.Client({ connectionString: DST });
await dst.connect();

const TABLES = ["transactions", "audit_trail", "checklist_entries", "notifications"];
for (const t of TABLES) {
  const cols = (await columnsOf(src, t)).filter((c) => c.column_name !== "id");
  await dst.query(ddlFor(t, cols));
}
await src.end();

// ── load production-sized data ─────────────────────────────────────────────
const LOAD = [
  `insert into transactions (transaction_number, business_id, type, category, amount_ghs, payment_method, description, date, recorded_by)
   select 'SCALE-'||g, 1 + (g % ${NBUS}), 'SALE', 'Poultry', 100 + (g % 500), 'Cash', 'synthetic scale row '||g, '2026-05-15', 'seed'
   from generate_series(1, 400000) g`,
  `insert into audit_trail (actor_user_id, actor_name, actor_role, action, target_type, target_label, business_id)
   select 1, 'Scale Actor', 'OWNER', 'SCALE_ROW', 'TRANSACTION', 'synthetic '||g, 1 + (g % ${NBUS})
   from generate_series(1, 400000) g`,
  `insert into checklist_entries (business_id, checklist_date, task_key, task_label)
   select 1 + (g % ${NBUS}), '2026-05-15', 'task_'||(g % 40), 'Synthetic task '||(g % 40)
   from generate_series(1, 600000) g`,
  `insert into notifications (user_id, type, title, is_read)
   select 1 + (g % 18), 'INFO', 'synthetic notification '||g, false
   from generate_series(1, 200000) g`,
];
for (const s of LOAD) {
  const t0 = Date.now();
  await dst.query(s);
  console.log(`  loaded: ${s.split("\n")[0].slice(0, 60)}… (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
await dst.query("analyze");
const counts = await dst.query(
  `select 'transactions' t, count(*) n from transactions
   union all select 'audit_trail', count(*) from audit_trail
   union all select 'checklist_entries', count(*) from checklist_entries
   union all select 'notifications', count(*) from notifications order by 1`
);
console.log("  fixture: " + counts.rows.map((r) => `${r.t}=${r.n}`).join("  "));

// ── measure each shape before/after its composite index ───────────────────
const results = [];
for (const s of SHAPES) {
  const before = await measure(dst, s.sql, s.args);
  await dst.query(s.index);
  await dst.query(`analyze ${s.index.match(/on (\w+)/)[1]}`);
  const after = await measure(dst, s.sql, s.args);
  results.push({ shape: s.name, before, after });
  console.log(
    `\n  ${s.name}\n    BEFORE ${before.ms.toFixed(1)} ms  ${before.plan}  (${before.buffers} buffers)\n` +
      `    AFTER  ${after.ms.toFixed(1)} ms  ${after.plan}  (${after.buffers} buffers)`
  );
}

async function measure(c, sql, args) {
  // warm once, then take the median of 5
  await c.query({ text: `explain (analyze, buffers) ${sql}`, values: args });
  const times = [];
  let plan = "";
  let buffers = 0;
  for (let i = 0; i < 5; i++) {
    const r = await c.query({ text: `explain (analyze, buffers) ${sql}`, values: args });
    const txt = r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    const m = txt.match(/Execution Time: ([\d.]+) ms/);
    times.push(parseFloat(m[1]));
    if (i === 2) {
      plan = txt
        .split("\n")[0]
        .replace(/^\S+\s+\(.*\)\s*\(.*\)\s*/, "")
        .slice(0, 46);
      const b = txt.match(/Buffers: shared hit=(\d+)(?: read=(\d+))?/);
      buffers = b ? Number(b[1]) + Number(b[2] || 0) : 0;
    }
  }
  times.sort((a, b) => a - b);
  return { ms: times[2], plan, buffers };
}

await dst.end();
console.log("\n  (fixture kept as database `app_scale` for follow-up EXPLAINs; drop with: drop database app_scale)");
