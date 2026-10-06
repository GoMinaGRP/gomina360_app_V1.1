#!/usr/bin/env node
/**
 * GoMina 360 — production-like ("WAN") benchmark.
 *
 * Runs the same endpoint set against an app instance whose database is behind
 * dev-tooling/latency-proxy.mjs (default 40 ms RTT, 50 Mbps). This is the
 * measurement that shows what a Vercel+Neon user feels, and — unlike localhost
 * — it exposes SEQUENTIAL ROUND TRIPS as wall-clock time.
 *
 * Usage:  PORT=3001 node dev-tooling/perf-wan.mjs [--out file.json]
 */
import http from "node:http";
import { writeFileSync } from "node:fs";
const PORT = Number(process.env.PORT || 3001);
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const BASE = `http://127.0.0.1:${PORT}`;
const login = async (email, password) => (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).sessionToken;
const get = (p, t) => new Promise((res) => {
  const t0 = performance.now();
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, headers: { "x-gomina-session": t, "Accept-Encoding": "gzip" } }, (x) => {
    let n = 0; x.on("data", (c) => (n += c.length));
    x.on("end", () => res({ status: x.statusCode, ms: performance.now() - t0, kb: n / 1024 }));
  });
  r.on("error", (e) => res({ error: e.message }));
  r.setTimeout(15000, () => { r.destroy(); res({ error: "timeout 15s" }); });
  r.end();
});
const tok = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
const bm = await login("emmanuel@gomina360.com", "GoMina@User3");
const PLAN = [
  ["init OWNER", "/api/init", tok], ["init BM", "/api/init", bm],
  ["audit OWNER", "/api/audit", tok], ["audit BM", "/api/audit", bm],
  ["businesses/1", "/api/businesses/1", tok], ["transactions", "/api/transactions", tok],
  ["transactions?biz=1", "/api/transactions?businessId=1", tok],
  ["payroll", "/api/payroll", tok], ["procurement", "/api/procurement", tok],
  ["users", "/api/users", tok], ["employees", "/api/employees", tok],
  ["fulfillment", "/api/fulfillment", tok], ["checklists?biz=1", "/api/checklists?businessId=1", tok],
];
const rows = [];
console.log(`\n  WAN benchmark → 127.0.0.1:${PORT} (DB behind 40 ms RTT emulator)\n`);
console.log("  endpoint                 p50      max     KB   status");
for (const [label, path, token] of PLAN) {
  await get(path, token);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await get(path, token));
  const ok = runs.filter((r) => !r.error).sort((a, b) => a.ms - b.ms);
  if (!ok.length) { console.log(`  ${label.padEnd(22)} ERROR`); continue; }
  const rec = { label, path, p50: +ok[Math.floor(ok.length / 2)].ms.toFixed(1), max: +ok[ok.length - 1].ms.toFixed(1), kb: +ok[0].kb.toFixed(1), status: ok[0].status };
  rows.push(rec);
  console.log(`  ${label.padEnd(22)} ${String(Math.round(rec.p50)).padStart(5)} ms ${String(Math.round(rec.max)).padStart(6)} ms ${String(rec.kb).padStart(6)}  ${rec.status}`);
}
if (OUT) { writeFileSync(OUT, JSON.stringify({ stamp: new Date().toISOString(), port: PORT, endpoints: rows }, null, 2)); console.log(`\n  saved → ${OUT}`); }
