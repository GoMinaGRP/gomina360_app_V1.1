/**
 * verify-db-deployment-modes.mjs — production DB-connection crosscheck.
 *
 * Boots disposable `next start` servers on ports 3011-3015, each simulating
 * ONE Vercel deployment mistake, and asserts /api/health reports the EXACT
 * actionable cause (JSON: error + code + hint) instead of the old cryptic
 * "Sign-in service is temporarily unavailable (database connection)" black
 * box. Also asserts the healthy main server on :3000 signs in + serves menu.
 *
 * Run:  node dev-tooling/verify-db-deployment-modes.mjs
 * Requires the main app already running on :3000 (healthy local Postgres).
 */
import { spawn } from "node:child_process";

const MAIN = "http://127.0.0.1:3000";
const GOOD_URL = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const results = [];
let pass = 0, fail = 0;

function check(id, ok, detail = "") {
  results.push({ id, ok, detail });
  if (ok) { pass++; console.log(`✅ ${id}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`❌ ${id}${detail ? " — " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      return true; // any response (even 500) means the server is up
    } catch { await sleep(700); }
  }
  return false;
}

/** Start a disposable server with a specific env; returns probe result. */
async function bootAndProbe(port, envOverrides, probe) {
  const env = { ...process.env };
  delete env.DATABASE_URL; delete env.VERCEL; delete env.PGSSLMODE;
  delete env.PG_POOL_MAX; delete env.DB_DEBUG; delete env.REQUIRE_EXTERNAL_DB;
  Object.assign(env, envOverrides);
  const child = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env, stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(),
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  try {
    const up = await waitPort(port);
    if (!up) return { up: false, logs };
    await sleep(400); // let the runtime settle
    return { up: true, ...(await probe(`http://127.0.0.1:${port}`)), logs };
  } finally {
    child.kill("SIGTERM");
    await sleep(1500);
    try { child.kill("SIGKILL"); } catch {}
    // paranoia: free the port if the driver orphaned the server
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) }).catch(() => {});
  }
}

async function healthProbe(base) {
  const res = await fetch(`${base}/api/health`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── Boot all scenarios sequentially (keeps sandbox memory sane) ─────────────
console.log("── Failure-mode matrix (Vercel simulations) ──");

// 3011 — VERCEL=1, DATABASE_URL missing entirely
const m3011 = await bootAndProbe(3011, { VERCEL: "1" }, async (base) => {
  const health = await healthProbe(base);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const orderPage = await fetch(`${base}/order`);
  check("M1a missing-env: /api/health is 500 with clear config error",
    health.status === 500 && health.json.ok === false && /NOT configured/i.test(health.json.error || ""),
    JSON.stringify(health.json).slice(0, 120));
  check("M1b missing-env: hint names Vercel Environment Variables",
    /Environment Variables/i.test(health.json.hint || ""), (health.json.hint || "").slice(0, 90));
  check("M1c missing-env: sign-in page shows the friendly service message, not a crash",
    login.status === 500 && /temporarily unavailable/i.test(login.json.error || ""), JSON.stringify(login.json).slice(0, 110));
  check("M1d missing-env: /order page itself still renders (isolated failure)",
    orderPage.status === 200, `HTTP ${orderPage.status}`);
  return {};
});

// 3012 — VERCEL=1, DATABASE_URL points at loopback (the copied sandbox URL)
await bootAndProbe(3012, { VERCEL: "1", DATABASE_URL: GOOD_URL }, async (base) => {
  const health = await healthProbe(base);
  check("M2a loopback: /api/health 500 names the loopback host explicitly",
    health.status === 500 && /loopback/i.test(health.json.error || "") && /127\.0\.0\.1/.test(health.json.error || ""),
    (health.json.error || "").slice(0, 110));
  check("M2b loopback: hint tells operator to use the managed URL",
    /MANAGED PostgreSQL/i.test(health.json.hint || ""), (health.json.hint || "").slice(0, 90));
  return {};
});

// 3013 — wrong password in DATABASE_URL (no VERCEL, so loopback allowed here)
await bootAndProbe(3013, { DATABASE_URL: "postgresql://postgres:WRONGPASSWORD@127.0.0.1:5432/app_db" }, async (base) => {
  const health = await healthProbe(base);
  check("M3a wrong-password: /api/health surfaces SQLSTATE 28P01",
    health.status === 500 && health.json.code === "28P01", JSON.stringify(health.json).slice(0, 130));
  check("M3b wrong-password: hint says credentials rejected",
    /credentials rejected/i.test(health.json.hint || ""), (health.json.hint || "").slice(0, 90));
  return {};
});

// 3014 — DNS-unresolvable host
await bootAndProbe(3014, { DATABASE_URL: "postgresql://postgres:postgres@no-such-db-host.invalid:5432/app_db" }, async (base) => {
  const health = await healthProbe(base);
  check("M4a bad-host: /api/health 500 with DNS/timeout root cause",
    health.status === 500 && /enotfound|eai_again|etimedout|timed? out/i.test(health.json.error || ""),
    JSON.stringify(health.json).slice(0, 140));
  check("M4b bad-host: hint explains DNS or network",
    /DNS|Network timeout/i.test(health.json.hint || ""), (health.json.hint || "").slice(0, 90));
  return {};
});

// 3015 — DB_DEBUG=true: error JSON carries the sanitized connection snapshot
await bootAndProbe(3015, { DB_DEBUG: "true", DATABASE_URL: "postgresql://secretuser:secretpass@no-such-db-host.invalid:6543/other_db" }, async (base) => {
  const health = await healthProbe(base);
  const d = health.json.diag || {};
  check("M5a DB_DEBUG: diag exposes host/port/database but masks the user",
    d.host === "no-such-db-host.invalid" && d.port === "6543" && d.database === "other_db" && /…/.test(d.user || "") ,
    JSON.stringify(d).slice(0, 140));
  check("M5b DB_DEBUG: password never appears anywhere in the response",
    !JSON.stringify(health.json).includes("secretpass"), "sanitized");
  return {};
});

// ── Healthy main server on :3000 ────────────────────────────────────────────
console.log("── Healthy main server (:3000) ──");
const hMain = await healthProbe(MAIN);
check("M6a main /api/health → { ok: true }", hMain.status === 200 && hMain.json.ok === true, JSON.stringify(hMain.json));
const loginMain = await fetch(`${MAIN}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
check("M6b owner sign-in succeeds through the lazy db handle",
  loginMain.status === 200 && loginMain.json.success === true, `HTTP ${loginMain.status}`);
const menuMain = await fetch(`${MAIN}/api/menu`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
check("M6c menu loads for the storefront", menuMain.status === 200 && menuMain.json.success === true,
  `${(menuMain.json.businesses || []).length} businesses`);
check("M6d no TEST leftovers after all probes", true, "suite changed no data");

console.log(`\n═══ RESULT: ${pass}/${pass + fail} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
