#!/usr/bin/env node
/**
 * backup-livedata.mjs — snapshot the owner's LIVE business data that no seed
 * or restore fixture covers, so a sandbox wipe can never silently eat it again
 * (we lost 3 storefront orders + the BLOCK-02 unit this way on 2026-08-26).
 *
 * Usage:
 *   node dev-tooling/backup-livedata.mjs            → writes dev-tooling/backups/livedata-backup.json
 *   node dev-tooling/backup-livedata.mjs --check    → prints what WOULD be captured, writes nothing
 *
 * What is captured (TEST / QA rows are NEVER captured):
 *   businesses          — every unit (seed units re-conflict & are skipped on replay;
 *                         UI-created units like BLOCK-02 are the point)
 *   customers           — every CRM customer (incl. group-shared legacy rows)
 *   customer_trackings  — every order/tracking (online + till + manual), incl.
 *                         delivery pins, payment state and status history
 *   sales_documents     — every receipt / invoice / quotation
 *   transactions        — every finance ledger row
 *
 * Column sets are read from information_schema at dump time, so new columns
 * ride along automatically. Replay (restore-livedata.mjs) inserts with
 * ON CONFLICT (id) DO NOTHING — never overwrites fresher live rows.
 */
import { createRequire } from "module";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname } from "path";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OUT = new URL("./backups/livedata-backup.json", import.meta.url).pathname;

const TABLES = ["businesses", "customers", "customer_trackings", "sales_documents", "transactions"];

// Columns whose text may carry a TEST marker → row skipped (suite hygiene).
const TEST_GUARD = {
  businesses: ["name", "code"],
  customers: ["name"],
  customer_trackings: ["tracking_code", "customer_name"],
  sales_documents: ["document_number", "customer_name"],
  transactions: ["transaction_number", "description"],
};

const pg = new Client({ connectionString: DB });
await pg.connect();

const backup = { capturedAt: new Date().toISOString(), app: "gomina360", tables: {} };
let total = 0;
for (const t of TABLES) {
  const guards = (TEST_GUARD[t] || [])
    .map((c) => `(COALESCE(${c}::text,'') !~* '^TEST' AND COALESCE(${c}::text,'') NOT LIKE '%TEST %' )`)
    .join(" AND ");
  const { rows } = await pg.query(`SELECT * FROM ${t}${guards ? ` WHERE ${guards}` : ""} ORDER BY id`);
  backup.tables[t] = rows;
  total += rows.length;
  console.log(`  ${t}: ${rows.length} row(s)`);
}

await pg.end();

if (process.argv.includes("--check")) {
  console.log(`check only — ${total} row(s) would be captured`);
  process.exit(0);
}

// Skip writing when nothing changed (keeps git noise down).
const next = JSON.stringify(backup, null, 1);
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    const strip = (o) => JSON.stringify(o.tables);
    if (strip(prev) === strip(backup)) {
      console.log(`UNCHANGED — ${total} row(s), backup left as-is`);
      process.exit(0);
    }
  } catch {}
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, next);
console.log(`WROTE ${OUT} — ${total} row(s) across ${TABLES.length} tables`);
