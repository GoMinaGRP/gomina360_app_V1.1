#!/usr/bin/env node
/**
 * Staff Attendance — clock in/out + GPS verification suite (live app, real browsers).
 *
 *   A. OWNER anchors POULTRY-01's GPS (UI, geofence on) — businesses row updated
 *   B. WORKER (Kwabena) on-site GPS clock-in → backdated 9.5h → clock-out:
 *      hours 9.5, OT 1.5, payroll register row auto-created (PRESENT/8h/1.5 OT)
 *   C. OFF-SITE clock-in (Kumasi GPS, ~250km) → flagged + reviewable; a manual
 *      register row for the same employee/day is never clobbered by the clock
 *   D. WORKER review gating: /api/attendance meta.canReview=false, no log rows
 *   E. Double clock-in refused (409); clock-out completes the OWNER shift
 *   F. GPS denied → MANUAL no-fix record still clocks in AND out (never blocks)
 *   G. Manager review panel: rows, GPS links, OFF-SITE badges, chips, filters
 *   Z. TEST purge + forensics (register, logs, employees, businesses GPS, txn)
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-attendance.mjs
 */
import { createRequire } from "module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
// Privileged clock flows run as the GENERAL_MANAGER so a live OWNER's own
// open shift (real user data) is never clocked out or otherwise modified.
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const WORKER = { id: 11, email: "kwabena.mensah@gomina360.com", pw: "GoMina@User11" };
const BIZ1 = 1; // POULTRY-01 — Kwabena's assignment
const ACCRA = { latitude: 5.6037, longitude: -0.187 };
const ACCRA_NEAR = { latitude: 5.60375, longitude: -0.18705, accuracy: 12 };
const KUMASI = { latitude: 6.6885, longitude: -1.6244, accuracy: 15 };

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name} — ${detail}`); console.error(`❌ ${name} — ${detail}`); }
}
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = (o) => { const d = new Date(); d.setDate(d.getDate() + Number(o)); return d.toISOString().slice(0, 10); };

async function loginPersona(browser, creds, geo) {
  const ctx = await browser.createBrowserContext();
  if (geo) {
    await ctx.overridePermissions(BASE, ["geolocation"]);
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource: the server responded with a status of (401|404|400|403|409)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return; // transport noise (presence beacon on context close / unreachable legacy avatar URLs)
    page.errors.push(t);
  });
  await page.setViewport({ width: 1440, height: 960 });
  if (geo) await page.setGeolocation(geo);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("[data-testid='login-email']", { timeout: 30000 });
  await page.type("[data-testid='login-email']", creds.email);
  await page.type("[data-testid='login-password']", creds.pw);
  await page.click("[data-testid='login-submit']");
  await page.waitForSelector("[data-testid='login-email']", { hidden: true, timeout: 30000 });
  await sleep(2400);
  return { ctx, page };
}

async function openClock(page) {
  if (!(await page.$("[data-testid='att-clock-panel']"))) {
    await page.click("[data-testid='att-clock-btn']");
    await page.waitForSelector("[data-testid='att-clock-panel']", { timeout: 10000 });
  }
  await sleep(700);
}
const apiPost = (page, path, body) =>
  page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, { path, body });
const apiGet = (page, path) =>
  page.evaluate(async (path) => {
    const r = await fetch(path);
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, path);

async function main() {
  await pg.connect();
  const b0 = {
    logs: (await q(`SELECT COALESCE(MAX(id),0) m FROM attendance_logs`)).rows[0].m,
    reg: (await q(`SELECT COALESCE(MAX(id),0) m FROM payroll_attendance`)).rows[0].m,
    regCount: (await q(`SELECT count(*) c FROM payroll_attendance`)).rows[0].c,
    emp: (await q(`SELECT COALESCE(MAX(id),0) m FROM employees`)).rows[0].m,
    empCount: (await q(`SELECT count(*) c FROM employees`)).rows[0].c,
    txn: (await q(`SELECT count(*) c FROM transactions`)).rows[0].c,
    sess: (await q(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m,
    biz1: (await q(`SELECT gps_lat, gps_lng, gps_radius_m FROM businesses WHERE id=$1`, [BIZ1])).rows[0],
  };

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  // TEST employee linked to Kwabena's login by email (payroll link proof).
  const [emp] = (await q(
    `INSERT INTO employees (name, role, business_id, branch, salary_ghs, phone, hire_date, status, email)
     VALUES ('TEST Kwabena Mensah','Farm Hand',$1,'POULTRY-01',1200,'0200000099',$2,'ACTIVE',$3) RETURNING id`,
    [BIZ1, D(0), WORKER.email])).rows;
  const EMP_ID = emp.id;

  const pages = [];
  try {
    // ── A. Owner anchors the branch GPS (UI) ─────────────────────────────
    console.log("── A. Geofence anchor (owner, UI) ──");
    const ownGeo = await loginPersona(browser, OWNER, ACCRA);
    const op = ownGeo.page; pages.push(op);
    // open Payroll Center → ATTENDANCE tab
    await op.evaluate(() => { [...document.querySelectorAll("aside *")].find((e) => (e.textContent || "").trim() === "Employees & Payroll")?.click(); });
    await sleep(2200);
    await op.click("[data-testid='emp-payroll-open']");
    await op.waitForSelector("[data-testid='prl-tab-ATTENDANCE']", { timeout: 25000 });
    await op.click("[data-testid='prl-tab-ATTENDANCE']");
    await op.waitForSelector("[data-testid='attl-root']", { timeout: 25000 });
    await sleep(1500);
    check("A1 review panel renders for the OWNER", true);
    await op.select("[data-testid='attl-filter-biz']", String(BIZ1));
    await sleep(1300);
    await op.click("[data-testid='attl-setloc']");
    await op.waitForFunction(
      () => (document.querySelector("[data-testid='attl-notice']")?.textContent || "").includes("anchored"),
      { timeout: 20000 },
    );
    const biz1After = (await q(`SELECT gps_lat, gps_lng, gps_radius_m FROM businesses WHERE id=$1`, [BIZ1])).rows[0];
    check("A2 branch anchored in DB with 300m geofence",
      Math.abs(Number(biz1After.gps_lat) - ACCRA.latitude) < 0.0005 &&
      Math.abs(Number(biz1After.gps_lng) - ACCRA.longitude) < 0.0005 &&
      Number(biz1After.gps_radius_m) === 300,
      JSON.stringify(biz1After));
    check("A3 anchor notice visible", true);

    // ── B. On-site clock-in → backdate → clock-out → payroll link ────────
    console.log("── B. On-site shift → payroll ──");
    const wk = await loginPersona(browser, WORKER, ACCRA_NEAR);
    const wp = wk.page; pages.push(wp);
    await openClock(wp);
    await wp.waitForSelector("[data-testid='att-clockin']", { timeout: 10000 });
    await wp.click("[data-testid='att-clockin']");
    await wp.waitForFunction(
      () => /Clocked in/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const inStatus = await wp.$eval("[data-testid='att-clock-status']", (e) => e.textContent || "");
    check("B1 worker clocked IN on-site at assigned branch",
      inStatus.includes("POULTRY-01") && !/OFF-SITE/.test(inStatus), inStatus.slice(0, 200));
    const log1 = (await q(
      `SELECT * FROM attendance_logs WHERE user_id=$1 AND employee_id=$2 ORDER BY id DESC LIMIT 1`,
      [WORKER.id, EMP_ID])).rows[0];
    check("B2 log row auto-recorded user, employee, business, branch, date, time, GPS",
      !!log1 && log1.branch_code === "POULTRY-01" && Number(log1.business_id) === BIZ1 &&
      log1.date === D(0) && !!log1.clock_in_at && log1.clock_in_method === "GPS" &&
      Math.abs(Number(log1.clock_in_lat) - ACCRA_NEAR.latitude) < 0.0005,
      JSON.stringify(log1 || {}).slice(0, 400));
    check("B3 distance from branch measured, NOT off-site",
      !!log1 && Number(log1.clock_in_distance_m) < 100 && log1.off_site_in === false, JSON.stringify(log1 || {}).slice(0, 300));

    // Backdate clock-in 9.5h, then clock out.
    await q(`UPDATE attendance_logs SET clock_in_at = clock_in_at - interval '9.5 hours' WHERE id=$1`, [log1.id]);
    await openClock(wp);
    await wp.waitForSelector("[data-testid='att-clockout']", { timeout: 10000 });
    await wp.click("[data-testid='att-clockout']");
    await wp.waitForFunction(
      () => /Clocked out/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const outStatus = await wp.$eval("[data-testid='att-clock-status']", (e) => e.textContent || "");
    check("B4 clock-out reports hours + OT + payroll handoff",
      /9\.5h/.test(outStatus) && /1\.5h OT/.test(outStatus) && /payroll/.test(outStatus), outStatus.slice(0, 240));
    const reg1 = (await q(
      `SELECT * FROM payroll_attendance WHERE employee_id=$1 AND date=$2 ORDER BY id DESC LIMIT 1`,
      [EMP_ID, D(0)])).rows[0];
    check("B5 payroll register auto-filled: PRESENT, 8h work + 1.5h OT (the payroll-run input)",
      !!reg1 && reg1.status === "PRESENT" && Number(reg1.hours_worked) === 8 &&
      Math.abs(Number(reg1.overtime_hours) - 1.5) < 0.01 && /Auto from clock/.test(reg1.note || ""),
      JSON.stringify(reg1 || {}).slice(0, 300));

    // ── C. Off-site clock-in (Kumasi) + manual register row wins ─────────
    console.log("── C. Off-site flag + manual precedence ──");
    await wp.setGeolocation(KUMASI);
    // Manual register row for yesterday — the clock must not clobber it.
    await q(
      `INSERT INTO payroll_attendance (employee_id, employee_name, business_id, branch_code, date, status, hours_worked, overtime_hours, note, recorded_by_name)
       VALUES ($1,'TEST Kwabena Mensah',$2,'POULTRY-01',$3,'ABSENT',0,0,'TEST manual register','Kwame Mina')`,
      [EMP_ID, BIZ1, D(-1)]);
    await openClock(wp);
    await wp.waitForSelector("[data-testid='att-clockin']", { timeout: 10000 });
    await wp.click("[data-testid='att-clockin']");
    await wp.waitForFunction(
      () => /OFF-SITE/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const offStatus = await wp.$eval("[data-testid='att-clock-status']", (e) => e.textContent || "");
    check("C1 off-site clock-in is SAVED but flagged with distance", /OFF-SITE/.test(offStatus) && /from branch/.test(offStatus), offStatus.slice(0, 240));
    await openClock(wp);
    await wp.waitForSelector("[data-testid='att-open-shift']", { timeout: 10000 });
    check("C2 open-shift badge warns OFF-SITE", !!(await wp.$("[data-testid='att-offsite-badge']")));
    await wp.screenshot({ path: "/home/user/att-2-offsite-worker.png" });
    // backdate that shift to yesterday, clock out (tests manual-precedence too).
    const log2 = (await q(`SELECT * FROM attendance_logs WHERE user_id=$1 AND employee_id=$2 AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1`, [WORKER.id, EMP_ID])).rows[0];
    await q(`UPDATE attendance_logs SET clock_in_at = $1::text::timestamp, date=$2 WHERE id=$3`, [`${D(-1)}T06:30:00`, D(-1), log2.id]);
    await openClock(wp);
    await wp.waitForSelector("[data-testid='att-clockout']", { timeout: 10000 });
    await wp.click("[data-testid='att-clockout']");
    await wp.waitForFunction(
      () => /Clocked out/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const log2b = (await q(`SELECT * FROM attendance_logs WHERE id=$1`, [log2.id])).rows[0];
    check("C3 off-site recorded on BOTH events with distances >150km",
      log2b.off_site_in === true && log2b.off_site_out === true &&
      Number(log2b.clock_in_distance_m) > 150000 && Number(log2b.clock_out_distance_m) > 150000,
      JSON.stringify(log2b).slice(0, 300));
    const manualRow = (await q(`SELECT * FROM payroll_attendance WHERE employee_id=$1 AND date=$2`, [EMP_ID, D(-1)])).rows;
    check("C4 manager's manual register row for that day NOT clobbered by the clock",
      manualRow.length === 1 && manualRow[0].status === "ABSENT" && manualRow[0].note === "TEST manual register",
      JSON.stringify(manualRow).slice(0, 300));

    // ── D. WORKER review gating ──────────────────────────────────────────
    console.log("── D. Review gating ──");
    const wMeta = await apiGet(wp, "/api/attendance");
    check("D1 WORKER cannot review staff locations (meta.canReview=false)",
      wMeta.status === 200 && wMeta.body?.meta?.canReview === false, JSON.stringify(wMeta.body?.meta));
    check("D2 WORKER review log list is empty (mine stay private, others hidden)",
      Array.isArray(wMeta.body?.logs) && wMeta.body.logs.length === 0 && (wMeta.body?.myLogs?.length ?? 0) >= 1, JSON.stringify({ logs: wMeta.body?.logs?.length, mine: wMeta.body?.myLogs?.length }));

    // ── E. Double clock-in refused; owner shift completes ────────────────
    console.log("── E. Double-in guard + privileged shift (GM) ──");
    const gm = await loginPersona(browser, GM, ACCRA);
    const gp = gm.page; pages.push(gp);
    await openClock(gp);
    await gp.waitForSelector("[data-testid='att-clock-biz']", { timeout: 10000 });
    await gp.select("[data-testid='att-clock-biz']", String(BIZ1));
    await gp.click("[data-testid='att-clockin']");
    await gp.waitForFunction(
      () => /Clocked in/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    await gp.waitForSelector("[data-testid='att-clockout']", { timeout: 10000 }); // state settled: now On duty
    const dbl = await apiPost(gp, "/api/attendance", { action: "CLOCK_IN", businessId: BIZ1 });
    check("E1 double clock-in refused (409) with clear message",
      dbl.status === 409 && /clock out first/i.test(dbl.body?.error || ""), JSON.stringify(dbl).slice(0, 200));
    await gp.screenshot({ path: "/home/user/att-1-clock-open.png" });
    await openClock(gp);
    await gp.waitForSelector("[data-testid='att-clockout']", { timeout: 10000 });
    await gp.click("[data-testid='att-clockout']");
    await gp.waitForFunction(
      () => /Clocked out/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const ownLog = (await q(`SELECT * FROM attendance_logs WHERE user_id=(SELECT id FROM users WHERE email=$1) ORDER BY id DESC LIMIT 1`, [GM.email])).rows[0];
    check("E2 privileged shift recorded + closed (on-site, branch POULTRY-01)",
      !!ownLog && !!ownLog.clock_out_at && ownLog.branch_code === "POULTRY-01" && ownLog.off_site_in === false);

    // ── F. GPS denied → MANUAL no-fix record still works ─────────────────
    console.log("── F. GPS denied fallback ──");
    const noGeo = await loginPersona(browser, GM, null); // no permission grant
    const np = noGeo.page; pages.push(np);
    await np.evaluate(() => {
      delete navigator.geolocation; // simulate a device/browser without GPS support
    });
    await openClock(np);
    await np.waitForSelector("[data-testid='att-clock-biz']", { timeout: 10000 });
    await np.select("[data-testid='att-clock-biz']", String(BIZ1));
    await np.click("[data-testid='att-clockin']");
    await np.waitForFunction(
      () => /Clocked in/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const mStatus = await np.$eval("[data-testid='att-clock-status']", (e) => e.textContent || "");
    check("F1 clock-in saved even with no GPS fix (never blocked)", /no GPS fix/.test(mStatus), mStatus.slice(0, 200));
    await openClock(np);
    await np.waitForSelector("[data-testid='att-clockout']", { timeout: 10000 });
    await np.click("[data-testid='att-clockout']");
    await np.waitForFunction(
      () => /Clocked out/.test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
      { timeout: 20000 },
    );
    const mLog = (await q(`SELECT * FROM attendance_logs WHERE user_id=(SELECT id FROM users WHERE email=$1) ORDER BY id DESC LIMIT 1`, [GM.email])).rows[0];
    check("F2 MANUAL method recorded on both events (truthful evidence)",
      mLog.clock_in_method === "MANUAL" && mLog.clock_out_method === "MANUAL" &&
      mLog.clock_in_lat === null && !!mLog.clock_out_at);

    // ── G. Manager review log: rows, badges, chips, filters ─────────────
    console.log("── G. Review log UI ──");
    await op.reload({ waitUntil: "networkidle0", timeout: 45000 });
    await sleep(2200);
    await op.evaluate(() => { [...document.querySelectorAll("aside *")].find((e) => (e.textContent || "").trim() === "Employees & Payroll")?.click(); });
    await sleep(2200);
    await op.click("[data-testid='emp-payroll-open']");
    await op.waitForSelector("[data-testid='prl-tab-ATTENDANCE']", { timeout: 25000 });
    await op.click("[data-testid='prl-tab-ATTENDANCE']");
    await op.waitForSelector("[data-testid='attl-root']", { timeout: 25000 });
    await sleep(1800);
    const tableTxt = await op.$eval("[data-testid='attl-table']", (e) => e.textContent || "");
    check("G1 log shows the shifts incl employee + branch + GPS links",
      tableTxt.includes("TEST Kwabena Mensah") && tableTxt.includes("POULTRY-01") && tableTxt.includes("6.6885"), tableTxt.slice(0, 240));
    check("G2 OFF-SITE badge rendered on the Kumasi row", !!(await op.$("[data-testid^='attl-offsite-']")));
    const offsiteChip = await op.$eval("[data-testid='attl-kpi-offsite']", (e) => e.textContent || "");
    check("G3 off-site chip counts the flagged shift", offsiteChip.includes("Off-Site Events") && /[1-9]/.test(offsiteChip.replace(/[^0-9]/g, "")), offsiteChip);
    // scope to today: B's 1.5h payroll-linked OT (C's backdated shift lands on D(-1)).
    await op.$eval("[data-testid='attl-filter-date']", (e, v) => { const r = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; r.call(e, v); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }, new Date().toISOString().slice(0, 10));
    await sleep(1400);
    check("G4 overtime chip shows today's 1.5h that went to payroll", (await op.$eval("[data-testid='attl-kpi-ot']", (e) => e.textContent || "")).includes("1.5"), await op.$eval("[data-testid='attl-kpi-ot']", (e) => e.textContent || ""));
    await op.$eval("[data-testid='attl-filter-date']", (e) => { const r = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; r.call(e, ""); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); });
    await sleep(1200);
    // filters: off-site only
    await op.click("[data-testid='attl-filter-offsite']");
    await sleep(1400);
    const offRows = await op.$$eval("[data-testid^='attl-row-']", (els) => els.map((e) => e.textContent || "").join("\n"));
    check("G5 off-site-only filter isolates the flagged shift", offRows.includes("TEST Kwabena Mensah") && !offRows.includes("Kwame Mina"), offRows.slice(0, 200));
    await op.click("[data-testid='attl-filter-offsite']");
    await sleep(1000);
    // employee filter
    await op.select("[data-testid='attl-filter-emp']", String(EMP_ID));
    await sleep(1400);
    const empRows = await op.$$eval("[data-testid^='attl-row-']", (els) => els.map((e) => e.textContent || "").join("\n"));
    check("G6 employee filter shows only that employee's shifts", empRows.includes("TEST Kwabena Mensah") && !empRows.includes("Kwame Mina"), empRows.slice(0, 200));
    await op.click("[data-testid='attl-filter-reset']");
    await sleep(1200);
    await op.screenshot({ path: "/home/user/att-3-review-log.png" });

    // phone overflow smoke on the panel
    await op.setViewport({ width: 390, height: 844 });
    await sleep(1200);
    const overflow = await op.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check("G7 phone (390px): panel has no page-level horizontal overflow", overflow <= 1, `${overflow}px`);
    await op.setViewport({ width: 1440, height: 960 });

    for (const p of pages) {
      const tag = p === op ? "owner-review" : p === wp ? "worker" : p === gp ? "gm" : "manual";
      check(`Z0.${tag} zero page errors`, p.errors.length === 0, p.errors.slice(0, 2).join(" | ").slice(0, 300));
    }
  } catch (err) {
    console.error("FATAL", err);
    failed++;
    try { await pages[0]?.screenshot({ path: "/home/user/att-error.png" }); } catch {}
  } finally {
    console.log("── Z. Purge + forensics ──");
    await browser.close().catch(() => {});
    await q(`DELETE FROM attendance_logs WHERE id > $1`, [b0.logs]);
    await q(`DELETE FROM payroll_attendance WHERE id > $1`, [b0.reg]);
    await q(`DELETE FROM employees WHERE id > $1`, [b0.emp]);
    await q(`UPDATE businesses SET gps_lat=$2, gps_lng=$3, gps_radius_m=$4 WHERE id=$1`,
      [BIZ1, b0.biz1.gps_lat, b0.biz1.gps_lng, b0.biz1.gps_radius_m]);
    await q(`DELETE FROM user_sessions WHERE id > $1`, [b0.sess]);

    const z = {
      logs: (await q(`SELECT COALESCE(MAX(id),0) m FROM attendance_logs`)).rows[0].m,
      regCount: (await q(`SELECT count(*) c FROM payroll_attendance`)).rows[0].c,
      empCount: (await q(`SELECT count(*) c FROM employees`)).rows[0].c,
      txn: (await q(`SELECT count(*) c FROM transactions`)).rows[0].c,
      biz1: (await q(`SELECT gps_lat, gps_lng, gps_radius_m FROM businesses WHERE id=$1`, [BIZ1])).rows[0],
    };
    check("Z1 forensics: attendance logs + register + employees back to baseline",
      String(z.logs) === String(b0.logs) && String(z.regCount) === String(b0.regCount) && String(z.empCount) === String(b0.empCount),
      JSON.stringify(z));
    check("Z2 forensics: POULTRY-01 GPS anchor restored + no stray transactions",
      String(z.biz1.gps_lat) === String(b0.biz1.gps_lat) && String(z.biz1.gps_lng) === String(b0.biz1.gps_lng) &&
      String(z.biz1.gps_radius_m) === String(b0.biz1.gps_radius_m) && String(z.txn) === String(b0.txn),
      JSON.stringify(z.biz1));
    await pg.end();
  }

  console.log("\n" + results.join("\n"));
  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed ? 1 : 0);
}

main();
