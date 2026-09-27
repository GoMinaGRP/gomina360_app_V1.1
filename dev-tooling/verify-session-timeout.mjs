#!/usr/bin/env node
/**
 * Session-timeout acceptance audit (API + DB + browser).
 *
 * Policy 2026-09: automatic logout / session retirement after **24 hours**
 * of inactivity (was 10 minutes), consistent for every user, role, business
 * and device. Authentication, permissions and security are untouched:
 *   • client-side idle auto-logout window = 24h (IdleLogout.tsx)
 *   • server-side idle ceiling            = 24h (SESSION_IDLE_MS, auth.ts)
 *   • absolute session lifetime (7 days)  = unchanged
 *   • lockout, scrypt hashing, org gates  = unchanged
 *
 * Verifies:
 *   S1. A session idle 23h still works (no premature logout).
 *   S2. A session idle 25h is retired (IDLE_TIMEOUT) and requires re-login.
 *   S3. Re-login after expiry succeeds and restores access.
 *   S4. Absolute 7-day TTL still enforced (security control intact).
 *   S5. Source constants are 24h on both sides (client + server).
 *   S6. Browser idle auto-logout mechanism still fires (via the test seam)
 *       and shows the re-login notice.
 *
 * Run with: bash dev-tooling/run-suite.sh dev-tooling/verify-session-timeout.mjs
 * (requires the app on http://localhost:3000 and DATABASE_URL reachable)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(DB);

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${body.error || ""}`);
  return body.sessionToken;
}
const H = (t) => ({ "Content-Type": "application/json", "x-gomina-session": t });

// ── S5. Source constants ────────────────────────────────────────────────────
console.log("── S5. Source constants (24h on both sides) ──");
const authSrc = readFileSync(path.join(REPO, "src/lib/auth.ts"), "utf8");
const idleSrc = readFileSync(path.join(REPO, "src/components/IdleLogout.tsx"), "utf8");
const appSrc = readFileSync(path.join(REPO, "src/components/GoMinaApp.tsx"), "utf8");
ok("server SESSION_IDLE_MS = 24 hours",
  /SESSION_IDLE_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(authSrc));
ok("client DEFAULT_IDLE_MS = 24 hours",
  /DEFAULT_IDLE_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(idleSrc));
ok("idle notice says 24 hours", /after 24 hours of inactivity/.test(appSrc));
ok("absolute 7-day TTL untouched",
  /SESSION_TTL_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(authSrc));

await client.connect();
try {
  // ── S1. 23h idle → still valid ────────────────────────────────────────────
  console.log("── S1. Session idle 23h is still valid ──");
  const t23 = await login(OWNER.email, OWNER.pw);
  await client.query(
    `UPDATE user_sessions SET last_seen_at = NOW() - INTERVAL '23 hours' WHERE token_hash = digest($1,'sha256')`,
    [t23]
  ).catch(async () => {
    // digest() needs pgcrypto; fall back to computing the hash in JS.
    const crypto = (await import("node:crypto")).default;
    const hash = crypto.createHash("sha256").update(t23).digest("hex");
    await client.query(
      `UPDATE user_sessions SET last_seen_at = NOW() - INTERVAL '23 hours' WHERE token_hash = $1`,
      [hash]
    );
  });
  let res = await fetch(`${BASE}/api/auth/me`, { headers: H(t23) });
  ok("23h-idle session still authenticated", res.status === 200, `got ${res.status}`);

  // ── S2. 25h idle → IDLE_TIMEOUT, requires re-login ────────────────────────
  console.log("── S2. Session idle 25h is retired ──");
  const t25 = await login(OWNER.email, OWNER.pw);
  const crypto = (await import("node:crypto")).default;
  const hash25 = crypto.createHash("sha256").update(t25).digest("hex");
  await client.query(
    `UPDATE user_sessions SET last_seen_at = NOW() - INTERVAL '25 hours' WHERE token_hash = $1`,
    [hash25]
  );
  res = await fetch(`${BASE}/api/auth/me`, { headers: H(t25) });
  ok("25h-idle session rejected (401)", res.status === 401, `got ${res.status}`);
  const ended = await client.query(
    `SELECT end_reason FROM user_sessions WHERE token_hash = $1`,
    [hash25]
  );
  ok("session row ended with IDLE_TIMEOUT", ended.rows[0]?.end_reason === "IDLE_TIMEOUT",
    `got ${ended.rows[0]?.end_reason}`);
  // And the retired token cannot reach data endpoints either.
  res = await fetch(`${BASE}/api/init`, { headers: H(t25) });
  ok("retired session cannot read /api/init", res.status === 401, `got ${res.status}`);
  // The 23h session was NOT collaterally damaged.
  res = await fetch(`${BASE}/api/auth/me`, { headers: H(t23) });
  ok("other live session unaffected", res.status === 200, `got ${res.status}`);

  // ── S3. Re-login after expiry ─────────────────────────────────────────────
  console.log("── S3. Re-login after expiry works ──");
  const tNew = await login(OWNER.email, OWNER.pw);
  res = await fetch(`${BASE}/api/auth/me`, { headers: H(tNew) });
  const me = await res.json();
  ok("re-login succeeds", res.status === 200 && me.success);
  ok("re-login restores the same identity", me.user?.email === OWNER.email);

  // ── S4. Absolute 7-day TTL still enforced ─────────────────────────────────
  console.log("── S4. Absolute 7-day TTL intact ──");
  const t7d = await login(OWNER.email, OWNER.pw);
  const hash7 = crypto.createHash("sha256").update(t7d).digest("hex");
  await client.query(
    `UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 hour', last_seen_at = NOW() WHERE token_hash = $1`,
    [hash7]
  );
  res = await fetch(`${BASE}/api/auth/me`, { headers: H(t7d) });
  ok("expired-TTL session rejected (401)", res.status === 401, `got ${res.status}`);
  const ended7 = await client.query(
    `SELECT end_reason FROM user_sessions WHERE token_hash = $1`,
    [hash7]
  );
  ok("session row ended with EXPIRED", ended7.rows[0]?.end_reason === "EXPIRED",
    `got ${ended7.rows[0]?.end_reason}`);

  // Cleanup: retire the test sessions we minted.
  for (const h of [hash25, hash7]) {
    await client.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [h]);
  }
} finally {
  await client.end();
}

// ── S6. Browser idle-logout mechanism (via the documented test seam) ───────
console.log("── S6. Browser idle auto-logout mechanism ──");
try {
  const req2 = createRequire(path.join(REPO, "node_modules"));
  const { chromium } = req2("playwright-core");
  const browser = await chromium.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[type="email"]', OWNER.email);
  await page.fill('input[type="password"]', OWNER.pw);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  // Seam: shrink the idle window to 4s; with NO interaction the app must
  // sign itself out and explain why on the sign-in screen.
  await page.evaluate(() => sessionStorage.setItem("gomina.idleMs", "4000"));
  await page.waitForTimeout(12000);
  const bodyText = (await page.locator("body").innerText()).slice(0, 3000);
  const signedOut = /Sign in|signed out automatically/i.test(bodyText);
  ok("idle auto-logout fires without interaction", signedOut);
  ok("sign-in screen explains the auto sign-out",
    /signed out automatically/i.test(bodyText));
  await browser.close();
} catch (e) {
  ok("browser idle-logout check", false, e.message);
}

console.log(`\n══ session-timeout audit: ${passed} passed, ${failed} failed ══`);
process.exit(failed ? 1 : 0);
