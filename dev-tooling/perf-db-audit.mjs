#!/usr/bin/env node
/**
 * GoMina 360 — static DB round-trip census.
 *
 * The number that explains "fast locally, slow after deploying to Vercel+Neon"
 * is ROUND TRIPS PER REQUEST: each `await db.…` is one network round trip once
 * the database is not on the same machine. This script counts them per API
 * route, flags routes that never batch (no Promise.all and no multi-statement
 * pool query), and flags SELECTs on large tables without a LIMIT.
 *
 * Usage:  node dev-tooling/perf-db-audit.mjs [--json]
 * No dependencies.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src/app/api");
const INIT_SNAPSHOT = join(ROOT, "src/lib/initSnapshot.ts");
const BIG_TABLES = [
  "transactions", "inventoryItems", "inventory_items", "customers", "users", "employees",
  "auditTrail", "audit_trail", "stockMovements", "checklistTemplates", "checklistEntries",
  "creditSales", "assets", "payments", "notifications",
];
const AS_JSON = process.argv.includes("--json");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

function analyse(file) {
  const src = readFileSync(file, "utf8");
  const roundTrips = (src.match(/await\s+(db|tx|getDb\(\))\./g) || []).length;
  const promiseAll = (src.match(/Promise\.all\(/g) || []).length;
  const batchedPool = /getPool\(\)\.query\(/.test(src);
  const limitCount = (src.match(/\.limit\(/g) || []).length;
  const unbounded = [];
  for (const table of BIG_TABLES) {
    const re = new RegExp(`from\\(\\s*${table}\\s*\\)`, "g");
    if (!re.test(src)) continue;
    // crude but effective: a statement block that reads a big table with no .limit( nearby
    const idx = src.search(new RegExp(`from\\(\\s*${table}\\s*\\)`));
    const window = src.slice(idx, idx + 420);
    if (!/\.limit\(|LIMIT\s+\d/.test(window)) unbounded.push(table);
  }
  return {
    route: relative(join(ROOT, "src/app/api"), file),
    roundTrips,
    promiseAll,
    batchedPool,
    limitCount,
    unbounded: [...new Set(unbounded)],
  };
}

if (!existsSync(API_DIR)) {
  console.error("Run this from the repository root (src/app/api not found).");
  process.exit(1);
}

const rows = walk(API_DIR).map(analyse).sort((a, b) => b.roundTrips - a.roundTrips);

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const total = rows.reduce((s, r) => s + r.roundTrips, 0);
console.log(`\nGoMina 360 — DB round-trip census (${rows.length} route files, ${total} round trips in total)\n`);
console.log("  round trips  Promise.all  batched  route");
console.log("  ───────────  ───────────  ───────  ─────");
for (const r of rows.slice(0, 25)) {
  console.log(
    `  ${String(r.roundTrips).padStart(11)}  ${String(r.promiseAll).padStart(11)}  ${(r.batchedPool ? " yes  " : "  no  ")}  ${r.route}`
  );
}

const serial = rows.filter((r) => r.roundTrips >= 20 && !r.batchedPool && r.promiseAll === 0);
console.log(`\n  ⚠ ${serial.length} routes make ≥20 round trips SEQUENTIALLY (no batching at all):`);
serial.forEach((r) => console.log(`      ${String(r.roundTrips).padStart(4)} × ${r.route}`));

const unboundedRoutes = rows.filter((r) => r.unbounded.length);
if (unboundedRoutes.length) {
  console.log("\n  ⚠ SELECTs on large tables without a nearby LIMIT:");
  unboundedRoutes.slice(0, 12).forEach((r) => console.log(`      ${r.route}: ${r.unbounded.join(", ")}`));
}

if (existsSync(INIT_SNAPSHOT)) {
  const snap = readFileSync(INIT_SNAPSHOT, "utf8");
  const statements = (snap.match(/stmts\.push\(/g) || []).length;
  const newestFirst = /const NEWEST_FIRST = ` ORDER BY "id" DESC`;/.test(snap);
  console.log("\n  /api/init bootstrap (src/lib/initSnapshot.ts):");
  console.log(
    `      ${statements} stmts.push(...) sites (source-numbered 1–28; the 8 log tables share one loop) → concatenated into ONE simple-protocol query (good)`
  );
  console.log(
    `      row caps: ${newestFirst && !/NEWEST_FIRST = ` ORDER BY "id" DESC LIMIT/.test(snap) ? "NONE — payload grows without bound (docs/PERFORMANCE-AUDIT.md §3 B1)" : "present"}`
  );
}

console.log("\n  Rule of thumb: production time ≈ local work + (round trips × RTT).");
console.log("  A 126-round-trip route costs +2.5 s at 20 ms RTT and +12 s at 95 ms RTT.\n");
