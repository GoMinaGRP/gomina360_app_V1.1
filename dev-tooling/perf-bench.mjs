#!/usr/bin/env node
/**
 * GoMina 360 — performance benchmark + structural fingerprint harness.
 *
 * Purpose: produce a rigorous before/after record for the performance work in
 * docs/PERFORMANCE-AUDIT.md. For every endpoint it records:
 *   • p50 / max response time (best-of-N warm runs)
 *   • bytes on the wire (gzip) and uncompressed bytes
 *   • HTTP status, Content-Encoding, Cache-Control, ETag presence
 *   • a STRUCTURAL FINGERPRINT of the JSON (per-array row counts + id sums +
 *     sorted key sets) so we can prove an optimisation did not change the data
 *     a caller receives — volatile fields (timestamps, generated ids) are
 *     excluded by design.
 *
 * Usage:
 *   node dev-tooling/perf-bench.mjs --out /tmp/perf-before.json
 *   node dev-tooling/perf-bench.mjs --out /tmp/perf-after.json
 *   node dev-tooling/perf-bench.mjs --compare /tmp/perf-before.json /tmp/perf-after.json
 *
 * Requires the app running on BASE (default http://127.0.0.1:3000).
 * PostgreSQL row-read accounting is included when the local DB is reachable.
 */

import http from "node:http";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = (flag("--base", process.env.PERF_BASE || "http://127.0.0.1:3000")).replace(/\/$/, "");
const RUNS = Number(flag("--runs", process.env.PERF_RUNS || 5));
const OUT = flag("--out");
const COMPARE = args.indexOf("--compare") >= 0;

const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", password: "GoMina@User3" };
const GM = { email: "abena.gm@gomina360.com", password: "GoMina@User2" };
const WORKER = { email: "akua.donkor@gomina360.com", password: "GoMina@User10" };

const url = new URL(BASE);
const HOST = url.hostname;
const PORT = Number(url.port || 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── fingerprinting ─────────────────────────── */

const VOLATILE = /(^(at|createdAt|updatedAt|generatedAt|serverTime|expiresAt|lastSeen|lastActive|heartbeatAt|fetchedAt|resolvedAt|readAt|issuedAt)$)|(_at$)|(Timestamp$)|(^token$)|(sessionToken)/i;

function isPrimitive(v) {
  return v === null || typeof v !== "object";
}

/** Deterministic, timestamp-insensitive structural summary of a JSON value. */
function fingerprint(value) {
  if (Array.isArray(value)) {
    const rowKeys = value.length && !isPrimitive(value[0]) ? Object.keys(value[0]).sort().join(",") : "";
    const ids = value.map((r) => (r && typeof r === "object" ? Number(r.id) : NaN)).filter((n) => Number.isFinite(n));
    return {
      kind: "array",
      length: value.length,
      idSum: ids.length ? ids.reduce((a, b) => a + b, 0) : null,
      idMax: ids.length ? Math.max(...ids) : null,
      rowKeys,
      // nested shape of the first row (one level), also timestamp-insensitive
      nested: value.length && !isPrimitive(value[0])
        ? Object.fromEntries(
            Object.entries(value[0])
              .filter(([k]) => !VOLATILE.test(k))
              .map(([k, v]) => [k, Array.isArray(v) ? `[${v.length}]` : isPrimitive(v) ? typeof v : `{${Object.keys(v).length}}`])
          )
        : null,
    };
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.test(k)) continue;
      out[k] = fingerprint(value[k]);
    }
    return { kind: "object", keys: Object.keys(value).filter((k) => !VOLATILE.test(k)).length, fields: out };
  }
  return { kind: typeof value };
}

/* ─────────────────────────── http helpers ─────────────────────────── */

function rawGet(path, headers = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request(
      { host: HOST, port: PORT, path, method: "GET", headers: { "Accept-Encoding": "gzip", ...headers } },
      (res) => {
        let wire = 0;
        const chunks = [];
        res.on("data", (c) => { wire += c.length; chunks.push(c); });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            wire,
            body: Buffer.concat(chunks),
            enc: res.headers["content-encoding"] || "none",
            cc: res.headers["cache-control"] || "",
            etag: res.headers["etag"] || "",
            xcache: res.headers["x-init-cache"] || "",
            ms: performance.now() - t0,
          })
        );
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function login(creds) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.sessionToken) throw new Error(`login failed (${creds.email}): ${res.status}`);
  return body.sessionToken;
}

/* ─────────────────────────── DB row accounting ─────────────────────────── */

async function dbProbe() {
  for (const anchor of [`${process.cwd()}/package.json`, "/home/user/pgtooling/package.json"]) {
    try {
      const require = createRequire(anchor);
      const { Client } = require("pg");
      const client = new Client(
        process.env.PERF_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db"
      );
      await client.connect();
      return {
        client,
        async rowsFor(fn) {
          const snap = async () => {
            const r = await client.query("SELECT tup_returned FROM pg_stat_database WHERE datname = current_database()");
            return Number(r.rows[0].tup_returned);
          };
          const before = await snap();
          const ms = await fn();
          await sleep(700); // shared-memory stats flush
          const after = await snap();
          return { rows: after - before, ms };
        },
      };
    } catch {
      /* try next anchor */
    }
  }
  return null;
}

/* ─────────────────────────── endpoint plan ─────────────────────────── */

const PLAN = [
  // public pages
  { label: "/ (login page)", path: "/", who: null, page: true },
  { label: "/order", path: "/order", who: null, page: true },
  { label: "/join", path: "/join", who: null, page: true },
  // boot
  { label: "init OWNER", path: "/api/init", who: "owner", db: true },
  { label: "init BM", path: "/api/init", who: "bm", db: true },
  { label: "branding", path: "/api/branding", who: "owner" },
  { label: "attendance", path: "/api/attendance", who: "owner" },
  { label: "notifications", path: "/api/notifications", who: "owner" },
  { label: "sales-documents", path: "/api/sales-documents", who: "owner" },
  { label: "currency/rates", path: "/api/currency/rates", who: "owner" },
  { label: "audit?meta=1", path: "/api/audit?meta=1", who: "owner" },
  // heavy screens
  { label: "audit OWNER", path: "/api/audit", who: "owner", db: true },
  { label: "audit BM", path: "/api/audit", who: "bm", db: true },
  { label: "audit WORKER", path: "/api/audit", who: "worker" },
  { label: "businesses/1", path: "/api/businesses/1", who: "owner", db: true },
  { label: "transactions (all)", path: "/api/transactions", who: "owner", db: true },
  { label: "transactions?businessId=1", path: "/api/transactions?businessId=1", who: "owner", db: true },
  { label: "users", path: "/api/users", who: "owner" },
  { label: "employees", path: "/api/employees", who: "owner" },
  { label: "menu", path: "/api/menu", who: "owner" },
  { label: "transport", path: "/api/transport", who: "owner" },
  { label: "procurement", path: "/api/procurement", who: "owner" },
  { label: "payroll", path: "/api/payroll", who: "owner" },
  { label: "block-factory", path: "/api/block-factory", who: "owner" },
  { label: "fulfillment", path: "/api/fulfillment", who: "owner" },
  { label: "enterprise INVENTORY", path: "/api/enterprise?entityType=INVENTORY", who: "owner" },
  { label: "checklists?businessId=1", path: "/api/checklists?businessId=1", who: "owner" },
  { label: "support-info", path: "/api/support-info", who: null },
  { label: "health", path: "/api/health", who: null },
];

/* ─────────────────────────── compare mode ─────────────────────────── */

if (COMPARE) {
  const before = JSON.parse(readFileSync(args[args.indexOf("--compare") + 1], "utf8"));
  const after = JSON.parse(readFileSync(args[args.indexOf("--compare") + 2], "utf8"));
  const fmt = (n, d = 1) => (n === null || n === undefined ? "—" : Number(n).toFixed(d));
  console.log(`\n════ BEFORE → AFTER (${before.stamp} → ${after.stamp}) ════\n`);
  console.log("  endpoint                          p50 ms           wire KB          delta      fingerprint");
  for (const b of before.endpoints) {
    const a = after.endpoints.find((x) => x.label === b.label);
    if (!a) continue;
    const p50 = b.p50 ? `${fmt(b.p50)} → ${fmt(a.p50)}` : "—";
    const wire = b.wireKb ? `${fmt(b.wireKb)} → ${fmt(a.wireKb)}` : "—";
    const d = b.p50 && a.p50 ? ((a.p50 - b.p50) / b.p50) * 100 : 0;
    const fp = b.fingerprint && a.fingerprint ? (b.fingerprint === a.fingerprint ? "same ✔" : "CHANGED ⚠") : "n/a";
    console.log(
      `  ${b.label.padEnd(32)} ${p50.padEnd(16)} ${wire.padEnd(16)} ${(d >= 0 ? "+" : "") + fmt(d, 0) + "%"}    ${fp}`
    );
  }
  console.log("");
  process.exit(0);
}

/* ─────────────────────────── main ─────────────────────────── */

const tokens = {};
for (const [who, creds] of Object.entries({ owner: OWNER, bm: BM, gm: GM, worker: WORKER })) {
  try { tokens[who] = await login(creds); } catch (e) { console.log(`  [warn] ${who} login failed: ${e.message}`); }
}

const db = await dbProbe();
const results = [];

console.log(`\nGoMina 360 perf-bench → ${BASE}   runs=${RUNS}   ${new Date().toISOString()}\n`);
console.log("  endpoint                          p50      max      wire       raw    status  enc   cc/etag");

for (const item of PLAN) {
  const token = item.who ? tokens[item.who] : "";
  if (item.who && !token) continue;
  const headers = token ? { "x-gomina-session": token } : {};

  const first = await rawGet(item.path, headers);
  if (first.error) { console.log(`  ${item.label.padEnd(32)} ERROR ${first.error}`); continue; }

  const times = [];
  let last = first;
  for (let i = 0; i < RUNS; i++) {
    const r = await rawGet(item.path, headers);
    if (r.error) continue;
    times.push(r.ms);
    last = r;
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? last.ms;
  const max = times[times.length - 1] ?? last.ms;

  let fingerprintHash = null;
  if (last.status === 200) {
    try {
      const text = last.enc === "gzip" ? gunzipSync(last.body).toString("utf8") : last.body.toString("utf8");
      const parsed = JSON.parse(text);
      const structural = fingerprint(parsed);
      // stable stringify (fingerprint() builds keys in sorted order already)
      fingerprintHash = createHash("sha1").update(JSON.stringify(structural)).digest("hex").slice(0, 12);
    } catch { /* not JSON (HTML pages) — no fingerprint */ }
  }

  const record = {
    label: item.label,
    path: item.path,
    who: item.who,
    status: last.status,
    p50: Math.round(p50 * 100) / 100,
    max: Math.round(max * 100) / 100,
    wireKb: Math.round((last.wire / 1024) * 10) / 10,
    rawKb: Math.round((last.body.length / 1024) * 10) / 10,
    enc: last.enc,
    cc: last.cc.slice(0, 60),
    etag: Boolean(last.etag),
    xcache: last.xcache,
    fingerprint: fingerprintHash,
  };

  if (item.db && db) {
    const { rows, ms } = await db.rowsFor(async () => (await rawGet(item.path, headers)).ms);
    record.dbRows = rows;
    record.dbMs = Math.round(ms * 100) / 100;
  }

  results.push(record);
  console.log(
    `  ${item.label.padEnd(32)} ${String(Math.round(p50)).padStart(5)} ms ${String(Math.round(max)).padStart(6)} ms ${String(record.wireKb).padStart(8)} KB ${String(record.rawKb).padStart(8)} KB  ${String(record.status).padStart(4)}  ${record.enc.padEnd(4)}  ${record.cc || (record.etag ? "etag" : "-")}${record.xcache ? ` [${record.xcache}]` : ""}${record.dbRows !== undefined ? `  dbRows=${record.dbRows}` : ""}`
  );
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ stamp: new Date().toISOString(), base: BASE, runs: RUNS, endpoints: results }, null, 2));
  console.log(`\n  saved → ${OUT}\n`);
} else {
  console.log("");
}
if (db) await db.client.end();
