#!/usr/bin/env node
/**
 * purge-test-rows — CLI around dev-tooling/lib/fixture-purge.mjs (H3).
 * Auto-run by bootstrap-sandbox.sh before the health check, and safe to run
 * any time: it only removes rows matching deliberately narrow suite-only
 * fixture patterns — real user/business data can never match.
 *
 * Usage: node dev-tooling/purge-test-rows.mjs [--dry-run]
 */
import { createRequire } from "module";
import { purgeByPatterns } from "./lib/fixture-purge.mjs";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const DRY = process.argv.includes("--dry-run");
// queryMode 'simple': the purge deliberately fires DELETEs at tables that may
// not carry the column (errors are swallowed by del()); on PGlite's socket
// multiplexer those extended-protocol error responses desync the connection
// — the simple protocol is immune. Identical behaviour on real Postgres.
const pg = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db", queryMode: "simple" });
pg.on("error", (e) => console.error("[purge] stray client noise:", e.message));
await pg.connect();

if (DRY) {
  for (const [label, q] of [
    ["businesses", `SELECT count(*)::int c FROM businesses WHERE name ILIKE 'MW-%' OR code ILIKE 'MW-%' OR name ILIKE 'TEST%' OR name ILIKE 'TEST %' OR name ILIKE 'Unrelated Biz %' OR name='kkkkk'`],
    ["organizations", `SELECT count(*)::int c FROM organizations WHERE name ILIKE 'MW-%' OR name ILIKE 'AU Unrelated Org %' OR name ILIKE 'TEST%'`],
    ["users", `SELECT count(*)::int c FROM users WHERE email ILIKE '%@demo.local' OR email ILIKE '%@mw-test.local' OR email ILIKE 'test.%' OR name ILIKE 'TEST %' OR name ILIKE 'Auditor One %'`],
    ["customers", `SELECT count(*)::int c FROM customers WHERE name ILIKE 'TEST %'`],
  ]) console.log(`  ${label}: ${(await pg.query(q)).rows[0].c} fixture row(s) would be purged`);
  await pg.end();
  process.exit(0);
}

const out = await purgeByPatterns(pg);
console.log(`purged: businesses=${out.businesses} organizations=${out.organizations} users=${out.users} customers=${out.customers} notifications=${out.notifications}`);
await pg.end();
