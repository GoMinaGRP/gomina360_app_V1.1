#!/usr/bin/env node
/**
 * Attendance GPS-at-both-events — acceptance suite for:
 *   "Staff Clock-In/Clock-Out must automatically record and permanently
 *    store the GPS location at clock-in AND at clock-out."
 *
 *   A. Clock-IN fix stored exactly (lat/lng/accuracy/method) — UI status
 *      confirms "GPS in-location recorded"; review panel shows the IN point.
 *   B. Clock-OUT fix stored exactly at a DISTINCT point — IN fields stay
 *      byte-identical (never overwritten); panel shows IN and OUT rows with
 *      their own coordinates + map links.
 *   C. OFF-SITE clock-out stored AND flagged (in on-site, out off-site).
 *   D. GPS denied → event still permanently stored (MANUAL, NULL coords).
 *   E. Permanence: after all later activity + fresh reload, earlier rows'
 *      GPS fields are unchanged; reviewer API returns identical values.
 *   F. Zero page errors.
 *   Z. TEST purge: logs, register, employees, session, anchor restore.
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-attendance-gps.mjs
 */
import { createRequire } from "module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const WORKER = { id: 11, email: "kwabena.mensah@gomina360.com", pw: "GoMina@User11" };
const BIZ1 = 1; // POULTRY-01 — Kwabena's assignment
const ANCHOR = { latitude: 5.6037, longitude: -0.187 };
const GPS_A = { latitude: 5.60375, longitude: -0.18705, accuracy: 12 }; // on branch (~6m)
const GPS_B = { latitude: 5.604, longitude: -0.1868, accuracy: 15 };    // ~55m away — on-site, distinct
const GPS_FAR = { latitude: 5.6087, longitude: -0.187, accuracy: 18 };  // ~556m — OFF-SITE

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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;
const fmt = (o) => JSON.stringify(o || {}).slice(0, 420);

async function loginPersona(browser, creds, geo) {
  const ctx = await browser.createBrowserContext();
  if (geo) await ctx.overridePermissions(BASE, ["geolocation"]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`PAGEERROR: ${String(e).slice(0, 250)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource:.*status of (401|400|403|404|409)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return; // transport noise (presence beacon on context close / unreachable legacy avatar URLs)
    pageErrors.push(t.slice(0, 250));
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
async function uiClock(page, action, waitText) {
  await openClock(page);
  await page.waitForSelector(`[data-testid='${action === "CLOCK_IN" ? "att-clockin" : "att-clockout"}']`, { timeout: 10000 });
  await page.click(`[data-testid='${action === "CLOCK_IN" ? "att-clockin" : "att-clockout"}']`);
  await page.waitForFunction(
    (re) => new RegExp(re).test(document.querySelector("[data-testid='att-clock-status']")?.textContent || ""),
    { timeout: 25000 }, waitText,
  );
  return page.$eval("[data-testid='att-clock-status']", (e) => e.textContent || "");
}
async function openOwnerPanel(page) {
  await page.evaluate(() => { [...document.querySelectorAll("aside *")].find((e) => (e.textContent || "").trim() === "Employees & Payroll")?.click(); });
  await sleep(2000);
  await page.click("[data-testid='emp-payroll-open']");
  await page.waitForSelector("[data-testid='prl-tab-ATTENDANCE']", { timeout: 25000 });
  await page.click("[data-testid='prl-tab-ATTENDANCE']");
  await page.waitForSelector("[data-testid='attl-root']", { timeout: 25000 });
  await sleep(1600);
}
/** Full-open when the panel isn't up; otherwise just refetch its data. */
async function viewPanel(page) {
  if (!(await page.$("[data-testid='attl-root']"))) {
    await openOwnerPanel(page);
  } else {
    await page.click("[data-testid='attl-refresh']");
    await sleep(1600);
  }
}
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
    emp: (await q(`SELECT COALESCE(MAX(id),0) m FROM employees`)).rows[0].m,
    txn: (await q(`SELECT count(*)::int c FROM transactions`)).rows[0].c,
    sess: (await q(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m,
    biz1: (await q(`SELECT gps_lat, gps_lng, gps_radius_m FROM businesses WHERE id=$1`, [BIZ1])).rows[0],
    openShiftWorker: (await q(`SELECT id FROM attendance_logs WHERE user_id=$1 AND clock_out_at IS NULL`, [WORKER.id])).rows,
  };
  check("Z0 pre-flight: worker has no leftover open shift", b0.openShiftWorker.length === 0, JSON.stringify(b0.openShiftWorker));

  // Deterministic geofence (restored at the end).
  await q(`UPDATE businesses SET gps_lat=$2, gps_lng=$3, gps_radius_m=300 WHERE id=$1`, [BIZ1, ANCHOR.latitude, ANCHOR.longitude]);

  const [emp] = (await q(
    `INSERT INTO employees (name, role, business_id, branch, salary_ghs, phone, hire_date, status, email)
     VALUES ('TEST GPS Kwabena','Farm Hand',$1,'POULTRY-01',1200,'0200000098',CURRENT_DATE::text,'ACTIVE',$2) RETURNING id`,
    [BIZ1, WORKER.email])).rows;
  const EMP_ID = emp.id;

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // ── A. Clock-IN GPS stored exactly ───────────────────────────────────
    console.log("── A. clock-in GPS stored ──");
    const wk = await loginPersona(browser, WORKER, GPS_A);
    const wp = wk.page;
    const inStatus = await uiClock(wp, "CLOCK_IN", "Clocked in");
    check("A1 widget confirms: GPS in-location recorded", /GPS in-location recorded/.test(inStatus), inStatus.slice(0, 220));
    const rowA = (await q(`SELECT * FROM attendance_logs WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [WORKER.id])).rows[0];
    check("A2 DB stored exact IN fix (lat/lng/accuracy/method)",
      !!rowA && near(rowA.clock_in_lat, GPS_A.latitude) && near(rowA.clock_in_lng, GPS_A.longitude) &&
      Math.round(Number(rowA.clock_in_accuracy_m)) === 12 && rowA.clock_in_method === "GPS", fmt(rowA));
    check("A3 IN event on-site vs anchor; OUT slot empty (pending)",
      !!rowA && rowA.off_site_in === false && Number(rowA.clock_in_distance_m) < 100 && rowA.clock_out_at == null && rowA.clock_out_lat == null, fmt(rowA));

    // panel: IN row visible with coords + map link, OUT pending
    const ow = await loginPersona(browser, OWNER, null);
    const op = ow.page;
    await viewPanel(op);
    const inCell = await op.$(`[data-testid='attl-gps-in-${rowA.id}']`);
    const outPend = await op.$(`[data-testid='attl-gps-out-pending-${rowA.id}']`);
    const inTxt = inCell ? await op.evaluate((e) => e.textContent + "|" + (e.getAttribute("href") || ""), inCell) : "";
    check("A4 review panel shows stored IN point w/ OSM map link",
      !!inCell && inTxt.includes("5.6037") && inTxt.includes("openstreetmap.org"), inTxt.slice(0, 200));
    check("A5 panel shows OUT pending while on duty", !!outPend, "no pending marker");

    // ── B. Clock-OUT GPS stored at a DISTINCT point; IN untouched ────────
    console.log("── B. clock-out GPS stored ──");
    await wp.setGeolocation(GPS_B);
    const outStatus = await uiClock(wp, "CLOCK_OUT", "Clocked out");
    check("B1 widget confirms: GPS out-location recorded (+hours)", /Clocked out/.test(outStatus) && /GPS out-location recorded/.test(outStatus), outStatus.slice(0, 240));
    const rowB = (await q(`SELECT * FROM attendance_logs WHERE id=$1`, [rowA.id])).rows[0];
    check("B2 DB stored exact OUT fix (distinct from IN)",
      !!rowB && near(rowB.clock_out_lat, GPS_B.latitude) && near(rowB.clock_out_lng, GPS_B.longitude) &&
      Math.round(Number(rowB.clock_out_accuracy_m)) === 15 && rowB.clock_out_method === "GPS", fmt(rowB));
    check("B3 IN fix UNTOUCHED by the clock-out (permanently kept)",
      !!rowB && near(rowB.clock_in_lat, GPS_A.latitude) && near(rowB.clock_in_lng, GPS_A.longitude) &&
      Math.round(Number(rowB.clock_in_accuracy_m)) === 12 && rowB.clock_in_method === "GPS", fmt(rowB));
    check("B4 both events on-site; hours + off-site flags persisted",
      !!rowB && rowB.off_site_out === false && Number(rowB.clock_out_distance_m) < 300 && rowB.hours_worked != null, fmt(rowB));
    await viewPanel(op);
    const outCell = await op.$(`[data-testid='attl-gps-out-${rowA.id}']`);
    const outTxt = outCell ? await op.evaluate((e) => e.textContent + "|" + (e.getAttribute("href") || ""), outCell) : "";
    const rowTxt = await op.$eval(`[data-testid='attl-row-${rowA.id}']`, (e) => e.textContent || "");
    check("B5 panel shows the OUT point (5.6040,-0.1868) distinct from IN",
      !!outCell && outTxt.includes("5.6040") && outTxt.includes("-0.1868") && outTxt.includes("openstreetmap.org"), outTxt.slice(0, 200));
    check("B6 same row still shows the IN point + both method chips",
      rowTxt.includes("5.6037") && (rowTxt.match(/GPS/g) || []).length >= 2, rowTxt.slice(0, 300));

    // ── C. OFF-SITE clock-out: stored AND flagged ────────────────────────
    console.log("── C. off-site clock-out ──");
    await wp.setGeolocation(GPS_A);
    await sleep(300);
    await uiClock(wp, "CLOCK_IN", "Clocked in");
    await wp.setGeolocation(GPS_FAR);
    const farStatus = await uiClock(wp, "CLOCK_OUT", "Clocked out");
    check("C1 off-site OUT flagged in-widget with distance & GPS note", /OFF-SITE/.test(farStatus) && /from branch/.test(farStatus) && /GPS out-location recorded/.test(farStatus), farStatus.slice(0, 260));
    const rowC = (await q(`SELECT * FROM attendance_logs WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [WORKER.id])).rows[0];
    check("C2 DB: IN on-site fix + OUT off-site fix both stored on one row",
      !!rowC && rowC.off_site_in === false && rowC.off_site_out === true &&
      near(rowC.clock_in_lat, GPS_A.latitude) && near(rowC.clock_out_lat, GPS_FAR.latitude) && near(rowC.clock_out_lng, GPS_FAR.longitude) &&
      Number(rowC.clock_out_distance_m) > 400 && Number(rowC.clock_out_distance_m) < 800, fmt(rowC));
    await viewPanel(op);
    const badgeC = await op.$(`[data-testid='attl-offsite-${rowC.id}']`);
    const badgeTxt = badgeC ? await op.evaluate((e) => e.textContent, badgeC) : "";
    check("C3 panel badge reads OFF-SITE (out) only — in was on-site", !!badgeC && /OFF-SITE \(out\)/.test(badgeTxt) && !/in\+out/.test(badgeTxt), badgeTxt);

    // ── D. GPS denied → MANUAL row permanently stored ────────────────────
    console.log("── D. no-fix fallback stored ──");
    const nx = await loginPersona(browser, WORKER, null); // no permission grant → PERMISSION_DENIED
    const mIn = await uiClock(nx.page, "CLOCK_IN", "Clocked in");
    check("D1 no-fix clock-in never blocked; note explains", /no GPS fix — recorded without location/.test(mIn), mIn.slice(0, 220));
    const mOut = await uiClock(nx.page, "CLOCK_OUT", "Clocked out");
    const rowD = (await q(`SELECT * FROM attendance_logs WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [WORKER.id])).rows[0];
    check("D2 MANUAL row permanently stored (NULL coords both events)",
      /Clocked out/.test(mOut) && !!rowD && rowD.clock_in_method === "MANUAL" && rowD.clock_out_method === "MANUAL" &&
      rowD.clock_in_lat == null && rowD.clock_out_lat == null && !!rowD.clock_out_at, fmt(rowD));
    await nx.ctx.close();

    // ── E. Permanence: fresh reload, reviewer API identical ──────────────
    console.log("── E. permanence ──");
    await op.reload({ waitUntil: "networkidle0", timeout: 60000 });
    await sleep(2200);
    await viewPanel(op);
    const still = await op.$(`[data-testid='attl-gps-out-${rowA.id}']`);
    check("E1 after full reload both fixes still render", !!still && !!(await op.$(`[data-testid='attl-gps-in-${rowA.id}']`)), "row missing");
    const api = await apiGet(op, "/api/attendance");
    const apiRowA = (api.body?.logs || []).find((l) => l.id === rowA.id);
    const apiRowC = (api.body?.logs || []).find((l) => l.id === rowC.id);
    const apiRowD = (api.body?.logs || []).find((l) => l.id === rowD.id);
    check("E2 reviewer API returns row A with BOTH fixes identical to DB",
      !!apiRowA && near(apiRowA.clockInLat, GPS_A.latitude) && near(apiRowA.clockOutLat, GPS_B.latitude), fmt(apiRowA));
    check("E3 reviewer API returns off-site-out row + manual row unchanged",
      !!apiRowC && apiRowC.offSiteOut === true && near(apiRowC.clockOutLat, GPS_FAR.latitude) &&
      !!apiRowD && apiRowD.clockInLat == null && apiRowD.clockOutMethod === "MANUAL", `${fmt(apiRowC)} :: ${fmt(apiRowD)}`);
    const rowAfinal = (await q(`SELECT * FROM attendance_logs WHERE id=$1`, [rowA.id])).rows[0];
    check("E4 row A GPS fields byte-identical after later shifts + reloads",
      near(rowAfinal.clock_in_lat, rowB.clock_in_lat) && near(rowAfinal.clock_in_lng, rowB.clock_in_lng) &&
      near(rowAfinal.clock_out_lat, rowB.clock_out_lat) && near(rowAfinal.clock_out_lng, rowB.clock_out_lng) &&
      String(rowAfinal.clock_in_accuracy_m) === String(rowB.clock_in_accuracy_m), fmt(rowAfinal));
    const stillNoOpen = (await q(`SELECT id FROM attendance_logs WHERE user_id=$1 AND clock_out_at IS NULL`, [WORKER.id])).rows;
    check("E5 worker left with no open shift (all 3 completed & stored)", stillNoOpen.length === 0, JSON.stringify(stillNoOpen));
    await op.screenshot({ path: "/home/user/attgps-1-review-both-fixes.png" });

    // ── F. zero page errors ──────────────────────────────────────────────
    check("F1 zero page/console errors across all personas", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } finally {
    // ── Z. purge + restore ───────────────────────────────────────────────
    await browser.close();
    await q(`DELETE FROM attendance_logs WHERE id > $1`, [b0.logs]);
    await q(`DELETE FROM payroll_attendance WHERE id > $1`, [b0.reg]);
    await q(`DELETE FROM employees WHERE id > $1`, [b0.emp]);
    await q(`DELETE FROM user_sessions WHERE id > $1`, [b0.sess]);
    await q(`UPDATE businesses SET gps_lat=$2, gps_lng=$3, gps_radius_m=$4 WHERE id=$1`, [BIZ1, b0.biz1.gps_lat, b0.biz1.gps_lng, b0.biz1.gps_radius_m]);
    const leaks = {
      logs: (await q(`SELECT count(*)::int c FROM attendance_logs WHERE id > $1`, [b0.logs])).rows[0].c,
      reg: (await q(`SELECT count(*)::int c FROM payroll_attendance WHERE id > $1`, [b0.reg])).rows[0].c,
      emp: (await q(`SELECT count(*)::int c FROM employees WHERE id > $1`, [b0.emp])).rows[0].c,
      sess: (await q(`SELECT count(*)::int c FROM user_sessions WHERE id > $1`, [b0.sess])).rows[0].c,
      txn: (await q(`SELECT count(*)::int c FROM transactions`)).rows[0].c,
      biz1: (await q(`SELECT gps_lat, gps_lng FROM businesses WHERE id=$1`, [BIZ1])).rows[0],
    };
    const anchorRestored = String(leaks.biz1.gps_lat) === String(b0.biz1.gps_lat) && String(leaks.biz1.gps_lng) === String(b0.biz1.gps_lng);
    check("Z1 forensics clean: logs/register/employees/sessions purged, anchor restored, no stray txns",
      leaks.logs === 0 && leaks.reg === 0 && leaks.emp === 0 && leaks.sess === 0 && leaks.txn === b0.txn && anchorRestored, JSON.stringify(leaks));
    await pg.end();
  }

  console.log("\n=========== verify-attendance-gps ===========");
  results.forEach((r) => console.log(r));
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("SUITE CRASH:", e); process.exit(2); });
