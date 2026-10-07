#!/usr/bin/env node
/**
 * GoMina 360 — DB round-trips per request (precise, runtime).
 *
 * Each Drizzle `await db.select()` runs in its own implicit transaction, so the
 * delta of pg_stat_database.xact_commit across a single request equals the
 * number of database round trips that request made (the batched multi-statement
 * reads of /api/init and the audit centre commit as ONE). This turns "126 round
 * trips" from a static guess into a measurement.
 *
 *   node dev-tooling/perf-roundtrips.mjs [--port 3000] [--db postgres://...]
 *
 * Requests are serialised (one at a time) so the delta is attributable.
 */

import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => (args.indexOf(n) >= 0 && args[args.indexOf(n) + 1] ? args[args.indexOf(n) + 1] : d);
const PORT = Number(flag("--port", 3000));
const DSN = flag("--db", "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const require = createRequire(`${process.cwd()}/package.json`);
const { Client } = require("pg");
const pg = new Client(DSN);
await pg.connect();

const commits = async () => {
  const r = await pg.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()");
  return Number(r.rows[0].xact_commit);
};

const login = async (email, password) =>
  (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).sessionToken;

const owner = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
const bm = await login("emmanuel@gomina360.com", "GoMina@User3");

async function roundTrips(label, path, token) {
  await fetch(BASE + path, { headers: { "x-gomina-session": token } }).then((r) => r.text());
  await sleep(600);
  const before = await commits();
  const t0 = performance.now();
  const res = await fetch(BASE + path, { headers: { "x-gomina-session": token } });
  const body = await res.text();
  const ms = performance.now() - t0;
  await sleep(900); // stats are collected in shared memory, flushed within ~1s
  const after = await commits();
  return { label, trips: after - before, ms: Math.round(ms), kb: Math.round((Buffer.byteLength(body) / 1024) * 10) / 10, status: res.status };
}

const PLAN = [
  ["/api/init OWNER", "/api/init", owner],
  ["/api/init BM", "/api/init", bm],
  ["/api/audit OWNER", "/api/audit", owner],
  ["/api/audit BM", "/api/audit", bm],
  ["/api/audit?meta=1", "/api/audit?meta=1", owner],
  ["/api/businesses/1", "/api/businesses/1", owner],
  ["/api/transactions", "/api/transactions", owner],
  ["/api/transactions?biz=1", "/api/transactions?businessId=1", owner],
  ["/api/checklists?biz=1", "/api/checklists?businessId=1", owner],
  ["/api/users", "/api/users", owner],
  ["/api/employees", "/api/employees", owner],
  ["/api/payroll", "/api/payroll", owner],
  ["/api/procurement", "/api/procurement", owner],
  ["/api/fulfillment", "/api/fulfillment", owner],
  ["/api/menu", "/api/menu", owner],
  ["/api/branding", "/api/branding", owner],
  ["/api/notifications", "/api/notifications", owner],
  ["/api/attendance", "/api/attendance", owner],
  ["/api/support-info", "/api/support-info", owner],
];

console.log(`\nGoMina 360 — DB round trips per request   (app :${PORT}, ${DSN.replace(/:[^:@]*@/, ":****@")})\n`);
console.log("  endpoint                        round trips   server ms   KB   status");
for (const [label, path, token] of PLAN) {
  const r = await roundTrips(label, path, token);
  console.log(`  ${label.padEnd(30)} ${String(r.trips).padStart(11)}   ${String(r.ms).padStart(9)}   ${String(r.kb).padStart(5)}  ${r.status}`);
}
await pg.end();
