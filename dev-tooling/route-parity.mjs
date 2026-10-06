#!/usr/bin/env node
/**
 * route-parity.mjs — proves the batched/paginated routes return the SAME DATA as
 * the pre-optimisation build.
 *
 * Compares :3002 (reference copy of the code before Task 6) against :3000 (the
 * optimised build) for several roles. For every probe it logs in as that role,
 * requests the endpoint and hashes the canonicalised payload, and separately
 * reports the row count of the main data array. Any difference is printed.
 *
 * Additive fields the optimisation deliberately introduces are listed in
 * IGNORE_KEYS so they do not mask real differences.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const http = req("http");
const crypto = await import("node:crypto");
const { gunzipSync } = await import("node:zlib");

const BEFORE = 3002;
const AFTER = 3000;

const ACTORS = {
  owner: ["kwame.owner@gomina360.com", "Owner@GoMina26"],
  bm: ["emmanuel@gomina360.com", "GoMina@User3"],
  worker: ["akua.donkor@gomina360.com", "GoMina@User10"],
  gm: ["abena.gm@gomina360.com", "GoMina@User2"],
};

const PROBES = [
  { label: "users", path: "/api/users", who: ["owner", "bm"] },
  { label: "notifications", path: "/api/notifications", who: ["owner", "bm", "worker"] },
  { label: "employees", path: "/api/employees", who: ["owner", "bm", "worker"] },
  { label: "payroll", path: "/api/payroll", who: ["owner", "bm"] },
  { label: "procurement", path: "/api/procurement", who: ["owner", "bm"] },
  { label: "fulfillment", path: "/api/fulfillment", who: ["owner", "bm"] },
  { label: "transactions", path: "/api/transactions", who: ["owner", "bm"] },
  { label: "init", path: "/api/init", who: ["owner", "bm"] },
  { label: "attendance", path: "/api/attendance", who: ["owner"] },
];

/** Fields the optimisation adds on purpose (present only in the AFTER build). */
const IGNORE_KEYS = new Set(["hasMore", "limit"]);

function request(port, path, { method = "GET", cookie, body } = {}) {
  return new Promise((res, rej) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        let buf = Buffer.concat(chunks);
        if (resp.headers["content-encoding"] === "gzip") {
          try { buf = gunzipSync(buf); } catch {}
        }
        res({
          status: resp.statusCode,
          cookie: (resp.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; "),
          text: buf.toString("utf8"),
        });
      });
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

async function login(port, actor) {
  const [email, password] = ACTORS[actor];
  const r = await request(port, "/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`login ${actor} on :${port} → ${r.status} ${r.text.slice(0, 80)}`);
  return r.cookie;
}

/** Stable canonical form: sort object keys, drop the deliberately added fields. */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (IGNORE_KEYS.has(k)) continue;
      out[k] = canon(value[k]);
    }
    return out;
  }
  return value;
}

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Row count of the "main" array in a payload (for a readable diff signal). */
function mainCount(json) {
  if (!json || typeof json !== "object") return "?";
  for (const [k, v] of Object.entries(json)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return `${k}=${v.length}`;
  }
  for (const [k, v] of Object.entries(json)) if (Array.isArray(v)) return `${k}=${v.length}`;
  return "n/a";
}

let same = 0;
const problems = [];

for (const actor of Object.keys(ACTORS)) {
  const cookieBefore = await login(BEFORE, actor);
  const cookieAfter = await login(AFTER, actor);
  for (const probe of PROBES) {
    if (!probe.who.includes(actor)) continue;
    const a = await request(BEFORE, probe.path, { cookie: cookieBefore });
    const b = await request(AFTER, probe.path, { cookie: cookieAfter });
    let ja = null, jb = null;
    try { ja = JSON.parse(a.text); } catch {}
    try { jb = JSON.parse(b.text); } catch {}
    const ha = hash(JSON.stringify(canon(ja)));
    const hb = hash(JSON.stringify(canon(jb)));
    const ok = a.status === b.status && ha === hb;
    const tag = ok ? "SAME " : "DIFF ";
    if (ok) same++;
    else problems.push({ actor, probe: probe.label, ha, hb, a: mainCount(ja), b: mainCount(jb), sa: a.status, sb: b.status });
    console.log(
      `  ${tag} ${probe.label.padEnd(14)} ${actor.padEnd(7)} ${a.status}/${b.status}  ` +
        `${ha}=${mainCount(ja)}  vs  ${hb}=${mainCount(jb)}`
    );
  }
}

console.log(`\n  ${same} identical, ${problems.length} different`);
for (const p of problems) {
  console.log(`   ⚠ ${p.probe} as ${p.actor}: ${p.sa}/${p.sb}  ${p.a} vs ${p.b}`);
}
if (problems.length) process.exitCode = 1;
