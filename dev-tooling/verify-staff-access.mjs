#!/usr/bin/env node
/**
 * Staff Photos + Signed-In Staff console — E2E acceptance suite.
 *
 *   A. Profile photo: upload → preview → saved to the user's profile (users
 *      .avatar_url, ≤700KB data URL) → shows in the top-right Staff menu
 *      (button + dropdown) → camera capture path → remove → fallback.
 *   B. Signed-In Staff board: OWNER sees the active worker with photo, role,
 *      business, branch, sign-in time, ONLINE presence; last-login and
 *      last-logout fill in as the worker signs out.
 *   C. Presence heartbeat: park on hidden/close → IDLE; a real request
 *      un-parks → ONLINE again.
 *   D. Disable: sessions die instantly, sign-in refused; Enable restores.
 *   E. Revoke: sessions die, password cleared, REVOKED chip; re-admission =
 *      Enable + owner password reset → login works again.
 *   F. Force sign-out: sessions end, access stays ENABLED.
 *   G. Authorization: owner-authorized manager (canManageUsers) manages only
 *      in-scope WORKER/BRANCH_MANAGER rows — never OWNER/GM, never
 *      out-of-scope; a manager WITHOUT the grant sees/manages nothing.
 *   H. Security negatives: profile PUT needs a session; bad photo → 400;
 *      worker gets canView=false; worker manage → 403; owner ≠ self-target.
 *   Z. TEST users removed, worker avatar restored, sessions purged, forensics.
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-staff-access.mjs
 */
import { createRequire } from "module";
import { writeFileSync } from "fs";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const WORKER = { id: 11, email: "kwabena.mensah@gomina360.com", pw: "GoMina@User11" };
const T_MGR = { email: "test.access.mgr@gominatest.local", pw: "TestMgr@123" };
const T_WKR = { email: "test.access.wkr@gominatest.local", pw: "TestWkr@123" };
const T_PLAIN = { email: "test.access.plain@gominatest.local", pw: "TestPlain@123" };
// 2×2 warm PNG (valid image for the upload path)
const TEST_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIHWP4z8DwHwMJQBNGhgcAAZ//A9HvRh6bAAAAAElFTkSuQmCC";

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name} — ${detail}`); console.error(`❌ ${name} — ${detail}`); }
}
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageErrors = [];
const fmt = (o) => JSON.stringify(o || {}).slice(0, 380);

async function makePage(browser, creds, { login = true } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`PAGEERROR: ${String(e).slice(0, 250)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource:.*status of (401|400|403|404|409|413)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return;
    pageErrors.push(t.slice(0, 250));
  });
  await page.setViewport({ width: 1440, height: 960 });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  if (login && creds) {
    await page.waitForSelector("[data-testid='login-email']", { timeout: 30000 });
    await page.type("[data-testid='login-email']", creds.email);
    await page.type("[data-testid='login-password']", creds.pw);
    await page.click("[data-testid='login-submit']");
    await page.waitForSelector("[data-testid='login-email']", { hidden: true, timeout: 30000 });
    await sleep(2400);
  }
  return { ctx, page };
}
const apiPost = (page, path, body) =>
  page.evaluate(async ({ path, body }) => {
    const method = body.method || "POST";
    const payload = body.data !== undefined ? body.data : body; // flat {action,...} or {method,data} wrapper
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, { path, body });
const apiGet = (page, path) =>
  page.evaluate(async (path) => {
    const r = await fetch(path);
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, path);

async function openUserMenu(page) {
  await page.click("[data-testid='user-menu-btn']");
  await page.waitForSelector("[data-testid='user-account-menu']", { timeout: 10000 });
  await sleep(250);
}
async function openEnterpriseUsers(page) {
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Enterprise Users"))?.click();
  });
  await page.waitForSelector("[data-testid='usr-tab-presence']", { timeout: 25000 });
  await sleep(800);
}
async function openPresence(page) {
  if (!(await page.$("[data-testid='usr-tab-presence']"))) await openEnterpriseUsers(page);
  await page.click("[data-testid='usr-tab-presence']");
  await page.waitForSelector("[data-testid='sis-root']", { timeout: 25000 });
  await sleep(1900);
}
async function refreshPresence(page) {
  await page.click("[data-testid='sis-refresh']");
  await sleep(1400);
}
const cellText = (page, tid) => page.$eval(`[data-testid='${tid}']`, (e) => (e.textContent || "").trim().replace(/\s+/g, " ")).catch(() => null);

async function main() {
  await pg.connect();
  const b0 = {
    worker: (await q(`SELECT avatar_url, is_active FROM users WHERE id=$1`, [WORKER.id])).rows[0],
    sess: (await q(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m,
    usersCount: (await q(`SELECT count(*)::int c FROM users`)).rows[0].c,
    bizCount: (await q(`SELECT count(*)::int c FROM businesses`)).rows[0].c,
  };
  check("Z0 pre-flight: worker baseline captured, no leftover TEST users",
    !!(await q(`SELECT 1 FROM users WHERE id=$1`, [WORKER.id])).rows[0] &&
    (await q(`SELECT count(*)::int c FROM users WHERE email LIKE 'test.access.%'`)).rows[0].c === 0,
    JSON.stringify(b0.worker));
  // Hygiene: a browser that closes WITHOUT signing out leaves a live (parked)
  // session row for up to the 7-day TTL — by design ("idle/away", like a
  // second device). End any such zombies for the worker so the sign-out and
  // park/un-park assertions below are deterministic.
  await q(`UPDATE user_sessions SET ended_at=NOW(), end_reason='TEST_BASELINE' WHERE user_id=$1 AND ended_at IS NULL`, [WORKER.id]);

  writeFileSync("/tmp/gomina-test-photo.png", Buffer.from(TEST_PNG_B64, "base64"));

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    ],
  });

  const testIds = [];
  try {
    // ═══ A. Profile photo — upload, camera, remove ═══════════════════════
    console.log("── A. profile photo ──");
    const wk = await makePage(browser, WORKER);
    const wp = wk.page;
    await openUserMenu(wp);
    check("A1 staff menu shows 'My Profile Photo'", !!(await wp.$("[data-testid='open-profile-photo']")), "menu item missing");
    await wp.click("[data-testid='open-profile-photo']");
    await wp.waitForSelector("[data-testid='ppm-root']", { timeout: 10000 });
    check("A2 modal opens showing current photo or initial fallback", !!(await wp.$("[data-testid='ppm-initial']")) || !!(await wp.$("[data-testid='ppm-preview']")), "no preview state");

    // upload path
    const input = await wp.$("[data-testid='ppm-file']");
    await input.uploadFile("/tmp/gomina-test-photo.png");
    await wp.waitForSelector("[data-testid='ppm-preview']", { timeout: 10000 });
    await wp.click("[data-testid='ppm-save']");
    await wp.waitForFunction(() => /saved to your profile/.test(document.querySelector("[data-testid='ppm-status']")?.textContent || ""), { timeout: 15000 });
    const saved1 = (await q(`SELECT avatar_url FROM users WHERE id=$1`, [WORKER.id])).rows[0].avatar_url;
    check("A3 upload saved to the user's profile (data URL on users.avatar_url)",
      typeof saved1 === "string" && saved1.startsWith("data:image/jpeg") && saved1.length > 500 && saved1.length < 700_000,
      (saved1 || "").slice(0, 60));
    await wp.waitForSelector("[data-testid='user-menu-photo']", { timeout: 20000 });
    const navSrc = await wp.$eval("[data-testid='user-menu-photo']", (e) => e.getAttribute("src") || "");
    check("A4 photo now renders in the top-right Staff menu button", navSrc.startsWith("data:image/jpeg"), navSrc.slice(0, 60));
    await wp.click("[data-testid='ppm-close']");
    await openUserMenu(wp);
    const lgSrc = await wp.$eval("[data-testid='user-menu-photo-lg']", (e) => e.getAttribute("src") || "").catch(() => "");
    check("A5 photo renders in the staff menu dropdown profile card", lgSrc.startsWith("data:image/jpeg"), lgSrc.slice(0, 60));
    await wp.keyboard.press("Escape");

    // camera path (fake device)
    await openUserMenu(wp);
    await wp.click("[data-testid='open-profile-photo']");
    await wp.waitForSelector("[data-testid='ppm-root']", { timeout: 10000 });
    await wp.click("[data-testid='ppm-camera-btn']");
    await wp.waitForSelector("[data-testid='ppm-video']", { timeout: 12000 });
    // deterministic: wait until the stream actually delivers frames
    await wp.waitForFunction(
      () => { const v = document.querySelector("[data-testid='ppm-video']"); return v && v.videoWidth > 0 && v.readyState >= 2; },
      { timeout: 12000 },
    );
    await sleep(400);
    await wp.click("[data-testid='ppm-snap']");
    await wp.waitForFunction(() => /Snapshot ready/.test(document.querySelector("[data-testid='ppm-status']")?.textContent || ""), { timeout: 10000 });
    await wp.click("[data-testid='ppm-save']");
    await wp.waitForFunction(() => /saved to your profile/.test(document.querySelector("[data-testid='ppm-status']")?.textContent || ""), { timeout: 15000 });
    const saved2 = (await q(`SELECT avatar_url FROM users WHERE id=$1`, [WORKER.id])).rows[0].avatar_url;
    check("A6 camera capture saved as the profile photo", typeof saved2 === "string" && saved2.startsWith("data:image/jpeg") && saved2 !== saved1, saved1 === saved2 ? "unchanged" : "ok");

    // remove path
    await wp.click("[data-testid='ppm-remove']");
    await wp.waitForFunction(() => /removed/.test(document.querySelector("[data-testid='ppm-status']")?.textContent || ""), { timeout: 15000 });
    const afterRemove = (await q(`SELECT avatar_url FROM users WHERE id=$1`, [WORKER.id])).rows[0].avatar_url;
    check("A7 remove clears the stored photo", afterRemove == null, String(afterRemove).slice(0, 40));
    await wp.click("[data-testid='ppm-close']");
    await sleep(1500);
    check("A8 staff menu falls back to the initial avatar after removal", !(await wp.$("[data-testid='user-menu-photo']")), "photo still rendered");

    // upload again — the photo must be visible on the OWNERS board (B+H)
    await openUserMenu(wp);
    await wp.click("[data-testid='open-profile-photo']");
    await wp.waitForSelector("[data-testid='ppm-root']", { timeout: 10000 });
    const input2 = await wp.$("[data-testid='ppm-file']");
    await input2.uploadFile("/tmp/gomina-test-photo.png");
    await wp.waitForSelector("[data-testid='ppm-preview']", { timeout: 10000 });
    await wp.click("[data-testid='ppm-save']");
    await wp.waitForFunction(() => /saved/.test(document.querySelector("[data-testid='ppm-status']")?.textContent || ""), { timeout: 15000 });
    await wp.click("[data-testid='ppm-close']");
    await wp.screenshot({ path: "/home/user/staff-1-menu-with-photo.png" });

    // ═══ B. Signed-In Staff board (worker currently active) ══════════════
    console.log("── B. signed-in staff board ──");
    const ow = await makePage(browser, OWNER);
    const op = ow.page;
    await openPresence(op);
    check("B1 board lists the active worker with photo, role, business, branch, sign-in time",
      !!await op.$(`[data-testid='sis-row-${WORKER.id}']`) &&
      (await cellText(op, `sis-role-${WORKER.id}`)) === "WORKER" &&
      ((await cellText(op, `sis-biz-${WORKER.id}`)) || "").includes("POULTRY-01") &&
      !!(await op.$eval(`[data-testid='sis-photo-${WORKER.id}']`, (e) => e.tagName === "IMG" && (e.getAttribute("src") || "").startsWith("data:image/")).catch(() => false)) &&
      ((await cellText(op, `sis-since-${WORKER.id}`)) || "").includes("2026-"),
      await cellText(op, `sis-biz-${WORKER.id}`));
    const statusW = await cellText(op, `sis-status-${WORKER.id}`);
    check("B2 worker reads ONLINE with live dot", statusW === "ONLINE" && !!(await op.$(`[data-testid='sis-online-${WORKER.id}']`)), statusW || "missing");
    check("B3 last-LOGIN column populated for the active worker",
      ((await cellText(op, `sis-login-${WORKER.id}`)) || "").includes("2026-"), await cellText(op, `sis-login-${WORKER.id}`));
    const kpi = await cellText(op, "sis-kpi-online");
    check("B4 KPI chips count online staff (≥2: owner + worker)", !!kpi && Number(/\d+/.exec(kpi)?.[0] || 0) >= 2, kpi || "");

    // worker signs out → last-logout fills, presence flips
    await openUserMenu(wp);
    await wp.click("[data-testid='logout-btn']");
    await sleep(2500);
    const ended = (await q(`SELECT end_reason, ended_at FROM user_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [WORKER.id])).rows[0];
    check("B5 sign-out SOFT-ends the session (row kept, end_reason LOGOUT, ended_at set)",
      ended?.end_reason === "LOGOUT" && !!ended?.ended_at, fmt(ended));
    await refreshPresence(op);
    const statusW2 = await cellText(op, `sis-status-${WORKER.id}`);
    check("B6 board shows worker SIGNED OUT with a real LAST LOGOUT time",
      statusW2 === "SIGNED OUT" && ((await cellText(op, `sis-logout-${WORKER.id}`)) || "").includes("2026-"),
      `${statusW2} / ${await cellText(op, `sis-logout-${WORKER.id}`)}`);
    await op.screenshot({ path: "/home/user/staff-2-signed-in-board.png" });

    // ═══ C. heartbeat park / un-park ═════════════════════════════════════
    console.log("── C. presence heartbeat ──");
    await wp.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await wp.waitForSelector("[data-testid='login-email']", { timeout: 30000 });
    await wp.type("[data-testid='login-email']", WORKER.email);
    await wp.type("[data-testid='login-password']", WORKER.pw);
    await wp.click("[data-testid='login-submit']");
    await wp.waitForSelector("[data-testid='login-email']", { hidden: true, timeout: 30000 });
    await sleep(2600);
    await refreshPresence(op);
    check("C1 worker ONLINE again after re-login", (await cellText(op, `sis-status-${WORKER.id}`)) === "ONLINE", await cellText(op, `sis-status-${WORKER.id}`));
    await apiPost(wp, "/api/session/heartbeat", { active: false });
    await sleep(500); // tight window: a background poll would legitimately un-park
    const saC2 = await apiGet(op, "/api/staff-access");
    const rowWC2 = (saC2.body?.staff || []).find((s) => s.id === WORKER.id);
    check("C2 park (page hidden/closed) → session kept, presence IDLE (not online)",
      !!rowWC2 && rowWC2.signedInNow === true && rowWC2.onlineNow === false, fmt(rowWC2));
    await apiGet(wp, "/api/auth/me"); // any real request un-parks
    await sleep(700);
    await refreshPresence(op);
    check("C3 real activity un-parks automatically → ONLINE", (await cellText(op, `sis-status-${WORKER.id}`)) === "ONLINE", await cellText(op, `sis-status-${WORKER.id}`));

    // ═══ D+E+F. access control on TEST users (never touch real staff) ══
    console.log("── D/E/F. access control ──");
    const ins = async (email, name, role, bizId) => (await q(
      `INSERT INTO users (name,email,role,phone,assigned_business_id,is_active) VALUES ($1,$2,$3,'0200000001',$4,true) RETURNING id`,
      [name, email, role, bizId])).rows[0].id;
    const tWkrId = await ins(T_WKR.email, "TEST Access Worker", "WORKER", 1);
    const tMgrId = await ins(T_MGR.email, "TEST Access Manager", "BRANCH_MANAGER", 1);
    const tPlainId = await ins(T_PLAIN.email, "TEST Plain Manager", "BRANCH_MANAGER", 1);
    testIds.push(tWkrId, tMgrId, tPlainId);
    // owner provisions passwords (+ user-management authority for the TEST manager)
    for (const [id, pw] of [[tWkrId, T_WKR.pw], [tMgrId, T_MGR.pw], [tPlainId, T_PLAIN.pw]]) {
      const r = await apiPost(op, "/api/users", { method: "PATCH", data: { userId: id, newPassword: pw } });
      if (!r.body?.success) throw new Error("provisioning failed: " + JSON.stringify(r));
    }
    const grant = await apiPost(op, "/api/users", { method: "PATCH", data: { userId: tMgrId, canManageUsers: true } });
    check("D0 owner provisioned TEST staff (passwords; delegated user-management granted)",
      !!grant.body?.success, fmt(grant.body));

    // D. Disable
    const tw = await makePage(browser, { email: T_WKR.email, pw: T_WKR.pw });
    await refreshPresence(op);
    check("D1 TEST worker signed in & visible on the board", !!(await op.$(`[data-testid='sis-row-${tWkrId}']`)), "row missing");
    await op.click(`[data-testid='sis-disable-${tWkrId}']`);
    await sleep(1700);
    const meAfterDisable = await apiGet(tw.page, "/api/auth/me");
    check("D2 disable kills all of the user's live sessions instantly", meAfterDisable.status === 401, `status=${meAfterDisable.status}`);
    const dbDis = (await q(`SELECT is_active, (SELECT end_reason FROM user_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1) r FROM users WHERE id=$1`, [tWkrId])).rows[0];
    check("D3 DB: is_active=false + sessions ended DISABLED", dbDis.is_active === false && dbDis.r === "DISABLED", fmt(dbDis));
    const blkCtx = await browser.createBrowserContext();
    const blkP = await blkCtx.newPage();
    await blkP.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await blkP.waitForSelector("[data-testid='login-email']", { timeout: 30000 });
    await blkP.type("[data-testid='login-email']", T_WKR.email);
    await blkP.type("[data-testid='login-password']", T_WKR.pw);
    await blkP.click("[data-testid='login-submit']");
    await sleep(1800);
    const blkErr = await cellText(blkP, "login-error");
    check("D4 disabled account cannot sign in (403 deactivated)", !!blkErr && /deactivated/i.test(blkErr), blkErr || "no error shown / logged in");
    await blkCtx.close();
    check("D5 board shows DISABLED chip", (await cellText(op, `sis-status-${tWkrId}`)) === "DISABLED", await cellText(op, `sis-status-${tWkrId}`));
    await op.click(`[data-testid='sis-enable-${tWkrId}']`);
    await sleep(1500);
    const twRetry = await makePage(browser, { email: T_WKR.email, pw: T_WKR.pw });
    check("D6 enable restores sign-in", !!(await twRetry.page.$("[data-testid='user-menu-btn']")), "still blocked");
    await twRetry.ctx.close();

    // E. Revoke + re-admission
    const tw2 = await makePage(browser, { email: T_WKR.email, pw: T_WKR.pw });
    await refreshPresence(op);
    await op.click(`[data-testid='sis-revoke-${tWkrId}']`);
    await op.waitForSelector("[data-testid='sis-revoke-modal']", { timeout: 8000 });
    await op.click("[data-testid='sis-revoke-confirm']");
    await sleep(1800);
    const dbRev = (await q(`SELECT is_active, access_revoked_at, password_hash, (SELECT end_reason FROM user_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1) r FROM users WHERE id=$1`, [tWkrId])).rows[0];
    check("E1 revoke: sessions ended REVOKED, password CLEARED, revoked stamp set",
      dbRev.is_active === false && !!dbRev.access_revoked_at && dbRev.password_hash == null && dbRev.r === "REVOKED", fmt(dbRev));
    const meAfterRevoke = await apiGet(tw2.page, "/api/auth/me");
    check("E2 revoked user's live page is dead immediately", meAfterRevoke.status === 401, `status=${meAfterRevoke.status}`);
    check("E3 board shows REVOKED chip", (await cellText(op, `sis-status-${tWkrId}`)) === "REVOKED", await cellText(op, `sis-status-${tWkrId}`));
    await op.click(`[data-testid='sis-enable-${tWkrId}']`);
    await sleep(1500);
    const twBlocked = await browser.createBrowserContext();
    const twBlockedP = await twBlocked.newPage();
    await twBlockedP.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await twBlockedP.waitForSelector("[data-testid='login-email']", { timeout: 30000 });
    await twBlockedP.type("[data-testid='login-email']", T_WKR.email);
    await twBlockedP.type("[data-testid='login-password']", T_WKR.pw);
    await twBlockedP.click("[data-testid='login-submit']");
    await sleep(1800);
    const noPwErr = await cellText(twBlockedP, "login-error");
    check("E4 enabled-after-revoke still cannot sign in: credentials were cleared", !!noPwErr && /No password set/i.test(noPwErr), noPwErr || "logged in!");
    await twBlocked.close();
    await tw2.ctx.close();
    await apiPost(op, "/api/users", { method: "PATCH", data: { userId: tWkrId, newPassword: T_WKR.pw } });
    const tw3 = await makePage(browser, { email: T_WKR.email, pw: T_WKR.pw });
    check("E5 full re-admission (enable + owner password reset) → sign-in works", !!(await tw3.page.$("[data-testid='user-menu-btn']")), "still blocked");

    // F. Force sign-out (access stays enabled)
    await refreshPresence(op);
    await op.click(`[data-testid='sis-signout-${tWkrId}']`);
    await sleep(1500);
    const meAfterForce = await apiGet(tw3.page, "/api/auth/me");
    const dbForce = (await q(`SELECT is_active, (SELECT end_reason FROM user_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1) r FROM users WHERE id=$1`, [tWkrId])).rows[0];
    check("F1 force sign-out kills sessions (FORCE_LOGOUT) but keeps access ENABLED",
      meAfterForce.status === 401 && dbForce.is_active === true && dbForce.r === "FORCE_LOGOUT", `${meAfterForce.status} ${fmt(dbForce)}`);
    const tw4 = await makePage(browser, { email: T_WKR.email, pw: T_WKR.pw });
    check("F2 user can sign straight back in after force sign-out", !!(await tw4.page.$("[data-testid='user-menu-btn']")), "blocked");
    await tw4.ctx.close();

    // ═══ G. owner-authorized manager scope ═══════════════════════════════
    console.log("── G. manager authorization ──");
    const gm = await makePage(browser, { email: T_MGR.email, pw: T_MGR.pw });
    const gmView = await apiGet(gm.page, "/api/staff-access");
    const gmEmails = (gmView.body?.staff || []).map((s) => s.email);
    check("G1 authorized manager can view; scope = own branches only (no HQ/owner/biz-2 staff)",
      gmView.body?.meta?.canView === true && gmEmails.includes(T_WKR.email) && gmEmails.includes(WORKER.email) &&
      !gmEmails.includes(OWNER.email) && !gmEmails.includes("kofi@gomina360.com"),
      gmEmails.join(","));
    const gmDis = await apiPost(gm.page, "/api/staff-access", { action: "SET_ACCESS", userId: tWkrId, status: "DISABLED" });
    const gmEn = await apiPost(gm.page, "/api/staff-access", { action: "SET_ACCESS", userId: tWkrId, status: "ACTIVE" });
    check("G2 authorized manager can disable/enable an in-scope worker", gmDis.body?.success === true && gmEn.body?.success === true, `${fmt(gmDis.body)} ${fmt(gmEn.body)}`);
    const g1 = await apiPost(gm.page, "/api/staff-access", { action: "SET_ACCESS", userId: 1, status: "DISABLED" });
    const g2 = await apiPost(gm.page, "/api/staff-access", { action: "SET_ACCESS", userId: 2, status: "DISABLED" });
    const g3 = await apiPost(gm.page, "/api/staff-access", { action: "SET_ACCESS", userId: 4, status: "DISABLED" });
    check("G3 manager can NEVER touch OWNER / GM / out-of-scope staff",
      g1.status === 403 && g2.status === 403 && g3.status === 403, `${g1.status},${g2.status},${g3.status}`);
    await gm.ctx.close();
    const pm = await makePage(browser, { email: T_PLAIN.email, pw: T_PLAIN.pw });
    const pmView = await apiGet(pm.page, "/api/staff-access");
    const pmAct = await apiPost(pm.page, "/api/staff-access", { action: "SET_ACCESS", userId: tWkrId, status: "DISABLED" });
    check("G4 manager WITHOUT owner authorization sees nothing & manages nothing",
      pmView.body?.meta?.canView === false && (pmView.body?.staff || []).length === 0 && pmAct.status === 403,
      `${fmt(pmView.body?.meta)} ${pmAct.status}`);
    await pm.ctx.close();
    const wView = await apiGet(wp, "/api/staff-access");
    check("G5 workers get canView=false (console hidden)", wView.body?.meta?.canView === false && (wView.body?.staff || []).length === 0, fmt(wView.body?.meta));

    // ═══ H. security negatives ═══════════════════════════════════════════
    console.log("── H. security ──");
    const anon = await fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photo: "data:image/png;base64,AAAA" }) });
    check("H1 profile PUT requires a session (401)", anon.status === 401, `status=${anon.status}`);
    const badPhoto = await apiPost(wp, "/api/profile", { method: "PUT", data: { photo: "data:text/html;base64,PGI+" } });
    check("H2 non-image photo refused (400)", badPhoto.status === 400 && badPhoto.body?.success === false, `status=${badPhoto.status}`);
    const tooBig = await apiPost(wp, "/api/profile", { method: "PUT", data: { photo: "data:image/png;base64," + "A".repeat(750_000) } });
    check("H3 oversized photo refused (413)", tooBig.status === 413, `status=${tooBig.status}`);
    const selfTarget = await apiPost(op, "/api/staff-access", { action: "SET_ACCESS", userId: 1, status: "DISABLED" });
    check("H4 nobody can disable the OWNER (self/target rule)", selfTarget.status === 403, `status=${selfTarget.status}`);
    const wkrAct = await apiPost(wp, "/api/staff-access", { action: "SET_ACCESS", userId: 4, status: "DISABLED" });
    check("H5 worker manage attempt refused (403)", wkrAct.status === 403, `status=${wkrAct.status}`);

    check("H6 zero page/console errors across every persona & flow", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } finally {
    // ═══ Z. forensics restore ═══════════════════════════════════════════
    await browser.close();
    if (testIds.length) await q(`DELETE FROM users WHERE id = ANY($1::int[])`, [testIds]);
    await q(`UPDATE users SET avatar_url=$2 WHERE id=$1`, [WORKER.id, b0.worker.avatar_url]);
    await q(`DELETE FROM user_sessions WHERE id > $1`, [b0.sess]);
    const leaks = {
      testUsers: (await q(`SELECT count(*)::int c FROM users WHERE email LIKE 'test.access.%'`)).rows[0].c,
      usersCount: (await q(`SELECT count(*)::int c FROM users`)).rows[0].c,
      sess: (await q(`SELECT count(*)::int c FROM user_sessions WHERE id > $1`, [b0.sess])).rows[0].c,
      workerAvatarSame: (await q(`SELECT avatar_url IS NOT DISTINCT FROM $2::text ok FROM users WHERE id=$1`, [WORKER.id, b0.worker.avatar_url])).rows[0].ok,
      workerActive: (await q(`SELECT is_active FROM users WHERE id=$1`, [WORKER.id])).rows[0].is_active,
      bizCount: (await q(`SELECT count(*)::int c FROM businesses`)).rows[0].c,
    };
    check("Z1 forensics: TEST users gone, worker avatar+access restored, sessions purged, business/users counts intact",
      leaks.testUsers === 0 && leaks.usersCount === b0.usersCount && leaks.sess === 0 &&
      leaks.workerAvatarSame === true && leaks.workerActive === b0.worker.is_active && leaks.bizCount === b0.bizCount,
      JSON.stringify(leaks));
    await pg.end();
  }

  console.log("\n=========== verify-staff-access ===========");
  results.forEach((r) => console.log(r));
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("SUITE CRASH:", e); process.exit(2); });
