#!/usr/bin/env node
/**
 * db-bursts.mjs — how many separate DB query bursts does ONE request cause?
 *
 * Uses pg_stat_database.xact_commit with pg_stat_force_next_flush() either side
 * of a single request, so the reading is exact (a multi-statement simple query
 * is one transaction, i.e. one round trip). Pair it with the latency emulator
 * for wall-clock cost; this tells you the COUNT.
 *
 *   node dev-tooling/db-bursts.mjs [port] [path ...]
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const PORT = Number(process.argv[2] || 3000);
const PATHS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["/api/audit", "/api/audit?meta=1", "/api/users", "/api/init"];

// Monitor from the `postgres` database: pg_stat_database counters are per-database,
// so the monitor's own statements must not land in app_db's count.
const monitor = new pg.Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" });
await monitor.connect();
const bursts = async () => {
  await monitor.query("select pg_stat_force_next_flush()");
  const r = await monitor.query("select xact_commit from pg_stat_database where datname='app_db'");
  return Number(r.rows[0].xact_commit);
};

const login = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }),
  });
  const j = await r.json();
  return j.sessionToken;
};
const token = await login();

console.log(`  DB query bursts per request (app :${PORT})\n`);
for (const path of PATHS) {
  // warm-up (fills caches, opens the pool connection)
  await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { "x-gomina-session": token } }).then((r) => r.text());
  await new Promise((r) => setTimeout(r, 200));
  const before = await bursts();
  const t0 = performance.now();
  const resp = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { "x-gomina-session": token } });
  await resp.text();
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 1200)); // backends publish stats ~1×/s
  const after = await bursts();
  console.log(`  ${path.padEnd(26)} ${String(after - before).padStart(3)} bursts   ${Math.round(ms).toString().padStart(5)} ms   ${resp.status}   (raw ${before}→${after})`);
}
await monitor.end();
