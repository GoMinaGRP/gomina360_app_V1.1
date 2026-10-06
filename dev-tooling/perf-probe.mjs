#!/usr/bin/env node
/**
 * GoMina 360 — performance probe (server + wire cost of the main pages and APIs).
 *
 * Reports per endpoint: status, wall time, bytes ON THE WIRE (with gzip), bytes
 * raw, and the response's cache/encoding headers. Companion to
 * docs/PERFORMANCE-AUDIT.md §9.
 *
 * Usage:
 *   node dev-tooling/perf-probe.mjs                     # default http://127.0.0.1:3000
 *   node dev-tooling/perf-probe.mjs http://localhost:3100
 *   PERF_OWNER_EMAIL=... PERF_OWNER_PASSWORD=... node dev-tooling/perf-probe.mjs
 *
 * No npm dependencies (global fetch + node:http only).
 */

import http from "node:http";
import { performance } from "node:perf_hooks";

const BASE = (process.argv[2] || process.env.PERF_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const OWNER = {
  email: process.env.PERF_OWNER_EMAIL || "kwame.owner@gomina360.com",
  password: process.env.PERF_OWNER_PASSWORD || "Owner@GoMina26",
};
const BM = {
  email: process.env.PERF_BM_EMAIL || "emmanuel@gomina360.com",
  password: process.env.PERF_BM_PASSWORD || "GoMina@User3",
};
const RUNS = Number(process.env.PERF_RUNS || 3);

const url = new URL(BASE);
const HOST = url.hostname;
const PORT = Number(url.port || (url.protocol === "https:" ? 443 : 80));

async function login(creds) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.sessionToken) throw new Error(`login failed for ${creds.email}: ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  return body.sessionToken;
}

/** Raw HTTP request that measures the bytes that actually cross the socket. */
function rawGet(path, headers = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const req = http.request(
      { host: HOST, port: PORT, path, method: "GET", headers: { "Accept-Encoding": "gzip", ...headers } },
      (res) => {
        let wire = 0;
        res.on("data", (c) => { wire += c.length; });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            wire,
            enc: res.headers["content-encoding"] || "none",
            ms: performance.now() - started,
            cc: res.headers["cache-control"] || "-",
            cache: res.headers["x-init-cache"] || "",
          })
        );
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function measure(label, path, token) {
  const headers = token ? { "x-gomina-session": token } : {};
  let best = null;
  for (let i = 0; i < Math.max(1, RUNS); i++) {
    const r = await rawGet(path, headers);
    if (r.error) { console.log(`  ${label.padEnd(30)} ERROR ${r.error}`); return; }
    if (!best || r.ms < best.ms) best = r;
  }
  console.log(
    `  ${label.padEnd(30)} ${String(best.status).padStart(3)}  ${kb(best.wire).padStart(9)} wire  ${String(Math.round(best.ms)).padStart(5)} ms  ${best.enc.padEnd(4)} ${
      best.cache ? `init:${best.cache}` : `cc=${best.cc.slice(0, 28)}`
    }`
  );
}

console.log(`\nGoMina 360 performance probe → ${BASE}  (best of ${RUNS} runs)\n`);

console.log("── PUBLIC PAGES ──");
await measure("/ (login page)", "/");
await measure("/order", "/order");
await measure("/track", "/track");
await measure("/join", "/join");

console.log("\n── SIGNED-OUT API ──");
await measure("/api/init (anonymous → 401)", "/api/init");

let owner = null;
let bm = null;
try { owner = await login(OWNER); } catch (e) { console.log(`\n  [warn] owner login unavailable: ${e.message}`); }
try { bm = await login(BM); } catch (e) { /* optional */ }

if (owner) {
  console.log("\n── DASHBOARD BOOT PATH (owner) ──");
  const boot = [
    ["/api/init", "/api/init"],
    ["/api/branding", "/api/branding"],
    ["/api/attendance", "/api/attendance"],
    ["/api/notifications", "/api/notifications"],
    ["/api/sales-documents", "/api/sales-documents"],
    ["/api/currency/rates", "/api/currency/rates"],
    ["/api/audit?meta=1", "/api/audit?meta=1"],
  ];
  for (const [label, p] of boot) await measure(label, p, owner);

  console.log("\n── HEAVIEST SCREENS (watch the ROUND TRIPS: node dev-tooling/perf-db-audit.mjs) ──");
  const heavy = [
    ["/api/audit (Audit & Review)", "/api/audit"],
    ["/api/businesses/1", "/api/businesses/1"],
    ["/api/transactions", "/api/transactions"],
    ["/api/payroll", "/api/payroll"],
    ["/api/procurement", "/api/procurement"],
    ["/api/fulfillment", "/api/fulfillment"],
    ["/api/users", "/api/users"],
    ["/api/menu", "/api/menu"],
  ];
  for (const [label, p] of heavy) await measure(label, p, owner);

  console.log("\n── repeat /api/init ×3 (shows the in-process TTL cache) ──");
  for (let i = 0; i < 3; i++) await measure(`/api/init #${i + 1}`, "/api/init", owner);
}

if (bm) {
  console.log("\n── /api/init for a ONE-UNIT branch manager (scope-size contrast) ──");
  await measure("/api/init (BM)", "/api/init", bm);
}

console.log("\nDone. Convert local times to production estimates with: time ≈ work + (round trips × RTT).\n");
