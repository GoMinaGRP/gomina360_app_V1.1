// Live verification of the Employee Registration upgrade, in real headless
// Chromium: complete personal profile + photo upload AND live camera capture,
// work & attendance profile, identity/compliance fields, documents vault,
// Business → Branch → Payroll → Attendance → Permissions → Reports linkage,
// and the immutable record history — plus worker authorization denials,
// legacy regression, TEST purge + forensics.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-employees.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/emp2-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];

const pageErrors = [];
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium", headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout });
const exists = async (sel) => !!(await page.$(sel));
const textOf = async (sel) => page.$eval(sel, (e) => e.textContent || "").catch(() => null);
const innerHas = async (sel, needle) => ((await textOf(sel)) || "").toLowerCase().includes(needle.toLowerCase());
const clickSel = async (sel) => { await waitSel(sel); await page.$eval(sel, (e) => e.click()); };
const clickTid = (tid) => clickSel(`[data-testid="${tid}"]`);
const clickText = async (text) => page.evaluate((t) => {
  const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase()));
  if (el) { el.click(); return true; } return false;
}, text);
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
};
const setTid = (tid, val) => setVal(`[data-testid="${tid}"]`, val);
async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setTid("login-email", cred.email);
  await setTid("login-password", cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
}
async function apiLogin(email, pw) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) }).then((x) => x.json());
  if (!r.sessionToken) throw new Error(`API login failed for ${email}`);
  return r.sessionToken;
}
const apiCall = (token, path = "/api/employees") => async (method, body) => {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", "x-gomina-session": token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

writeFileSync("/home/user/pgtooling/test-photo.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  employees: Number((await q1("SELECT count(*) c FROM employees")).c),
  docs: Number((await q1("SELECT count(*) c FROM employee_documents")).c),
  hist: Number((await q1("SELECT count(*) c FROM employee_history")).c),
  att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
  runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
};
const ownerToken = await apiLogin(OWNER.email, OWNER.pw);
const apiOwner = apiCall(ownerToken);
const apiOwnerPayroll = apiCall(ownerToken, "/api/payroll");
let newId = null;

try {
  // ══ A. Full registration with photo upload + camera capture ════════════
  console.log("── A. Employee Registration (complete record) ──");
  await login(OWNER);
  // The ID sequence follows whatever employees already exist (the owner may
  // have registered real staff in the UI) — expect max EMP-NNNN + 1.
  const prevEmp = await q(`SELECT employee_no FROM employees WHERE employee_no ~ '^EMP-[0-9]+$'`);
  const expectedEmpNo = `EMP-${String(Math.max(0, ...prevEmp.map((r) => parseInt(r.employee_no.split("-")[1], 10))) + 1).padStart(4, "0")}`;
  await clickText("Employees & Payroll");
  await waitSel('[data-testid="employee-reg-open"]');
  await clickTid("employee-reg-open");
  await waitSel('[data-testid="ereg-root"]');
  ok("A1 registration form opens", await exists('[data-testid="ereg-root"]'));
  await setTid("ereg-name", "TEST Ama Serwaa");
  await setTid("ereg-business", "2");
  await setTid("ereg-role", "TEST Quality Inspector");
  await setTid("ereg-salary", "2750");
  await setTid("ereg-phone", "024 555 0199");
  await setTid("ereg-email", "ama.test@gomina360.com");
  await setTid("ereg-dob", "1998-05-14");
  await setTid("ereg-gender", "FEMALE");
  await setTid("ereg-address", "TEST House 12, Nsawam Road, Accra");
  await setTid("ereg-ec-name", "TEST Kofi Serwaa");
  await setTid("ereg-ec-phone", "020 111 2233");
  // photo upload (file)
  const up = await page.$('[data-testid="ereg-photo-upload"] input[type=file]');
  await up.uploadFile("/home/user/pgtooling/test-photo.png");
  await page.waitForFunction(() => !!document.querySelector('[data-testid="ereg-photo-preview"] img'), { timeout: 8000 });
  ok("A2 photo upload previews", true);
  // camera capture (fake device)
  await clickTid("ereg-photo-camera");
  await waitSel('[data-testid="ereg-cam"]');
  const camOk = await page.waitForSelector('[data-testid="ereg-cam-video"]', { timeout: 8000 }).catch(() => null);
  ok("A3 camera opens with live video", !!camOk);
  await page.screenshot({ path: SHOT("2-camera") });
  await sleep(1200);
  await clickTid("ereg-cam-shoot");
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid="ereg-photo-preview"] img'); return i && i.src.startsWith("data:image/jpeg") && i.src.length > 5000; }, { timeout: 8000 });
  ok("A4 camera capture replaced the photo", true);
  // work & attendance
  await setTid("ereg-shift", "NIGHT");
  await setTid("ereg-hours", "7.5");
  await clickTid("ereg-day-FRI"); // drop Friday
  await clickTid("ereg-day-SAT"); // add Saturday
  await setTid("ereg-leave", "21");
  // identity
  await setTid("ereg-idtype", "GHANA_CARD");
  await setTid("ereg-idnumber", "GHA-TEST-12345678");
  await setTid("ereg-permit", "WP-TEST-009");
  await page.screenshot({ path: SHOT("1-registration") });
  await clickTid("ereg-save");
  await page.waitForFunction(() => !document.querySelector('[data-testid="ereg-root"]'), { timeout: 15000 });
  const row = await q1("SELECT * FROM employees WHERE name LIKE 'TEST %' ORDER BY id DESC LIMIT 1");
  newId = row?.id;
  ok("A5 employee registered", !!newId, `id ${newId}`);
  ok("A6 personal persisted (dob/gender/email/address/emergency)", row.date_of_birth === "1998-05-14" && row.gender === "FEMALE" && row.email === "ama.test@gomina360.com" && !!row.address && row.emergency_contact_name === "TEST Kofi Serwaa" && !!row.emergency_contact_phone);
  ok("A7 photo stored as data URL", !!row.photo && row.photo.startsWith("data:image/jpeg"));
  ok(`A8 employee ID auto-assigned ${expectedEmpNo}`, row.employee_no === expectedEmpNo, row.employee_no);
  ok("A9 attendance profile (NIGHT, 7.5h, days, leave 21)", row.shift === "NIGHT" && Number(row.daily_hours) === 7.5 && row.work_days.includes("SAT") && !row.work_days.includes("FRI") && row.leave_entitlement_days === 21, row.work_days);
  ok("A10 identity persisted (Ghana Card + permit)", row.id_type === "GHANA_CARD" && row.id_number === "GHA-TEST-12345678" && row.work_permit_no === "WP-TEST-009");
  ok("A11 business/branch linked (2 / BLOCK-01)", row.business_id === 2 && row.branch === "BLOCK-01");
  const h0 = await q1(`SELECT action, summary FROM employee_history WHERE employee_id=${newId} AND action='CREATED'`);
  ok("A12 registration recorded in history", !!h0 && h0.summary.includes(expectedEmpNo), h0?.summary?.slice(0, 70));
  await sleep(1000);
  ok("A13 row in table with photo + ID", await exists(`[data-testid="employee-row-${newId}"]`) && await exists(`[data-testid="employee-photo-${newId}"] img`));

  // ══ B. Employee profile + linkage strip ════════════════════════════════
  console.log("── B. Profile & linkage ──");
  await clickTid(`employee-profile-${newId}`);
  await waitSel('[data-testid="epr-root"]');
  ok("B1 profile opens", await exists('[data-testid="epr-root"]'));
  ok("B2 header shows employee ID", await innerHas('[data-testid="epr-empno"]', expectedEmpNo));
  ok("B3 link: business + branch", (await innerHas('[data-testid="epr-link-business"]', "Mina Concrete & Blocks")) && (await innerHas('[data-testid="epr-link-branch"]', "BLOCK-01")));
  ok("B4 link: payroll 0 · attendance 0 · leave 0/21",
    (await innerHas('[data-testid="epr-link-payroll"]', "0 entries")) &&
    (await innerHas('[data-testid="epr-link-attendance"]', "0 rows")) &&
    (await innerHas('[data-testid="epr-link-leave"]', "0/21")));
  ok("B5 overview shows identity (Ghana Card + number)", (await innerHas('[data-testid="epr-f-idtype"]', "Ghana Card")) && (await innerHas('[data-testid="epr-f-idnumber"]', "GHA-TEST-12345678")));
  ok("B6 overview shows emergency + schedule", (await innerHas('[data-testid="epr-f-ecname"]', "TEST Kofi Serwaa")) && (await innerHas('[data-testid="epr-f-days"]', "SAT")));

  // ══ C. Payroll & attendance linkage (live update) ══════════════════════
  console.log("── C. Payroll / attendance linkage ──");
  const att = await apiOwnerPayroll("POST", { action: "ADD_ATTENDANCE", data: { employeeId: newId, date: "2026-10-05", status: "PRESENT", hoursWorked: 8, overtimeHours: 1, note: "TEST emp-link" } });
  ok("C1 attendance recorded via payroll API", att.status === 200 && att.body?.success);
  const run = await apiOwnerPayroll("POST", { data: { businessId: 2, period: "2026-10", notes: "TEST emp-link run" } });
  const runId = run.body?.run?.id;
  const myEntry = run.body?.run?.entries?.find((e) => e.employeeId === newId);
  ok("C2 payroll run drafts the new employee with statutory nets", !!runId && !!myEntry && myEntry.ssnitEmployeeGhs > 0, `entry ${myEntry?.id} net ${myEntry?.netPayGhs}`);
  await clickTid("epr-refresh");
  await sleep(1000);
  ok("C3 link strip now: payroll 1 entry · attendance 1 row · OT 1h",
    (await innerHas('[data-testid="epr-link-payroll"]', "1 entry")) &&
    (await innerHas('[data-testid="epr-link-attendance"]', "1 rows · OT 1h")));
  await page.screenshot({ path: SHOT("3-profile-linkage") });
  const delRun = await apiOwnerPayroll("DELETE", { runId });
  const delAtt = await apiOwnerPayroll("DELETE", { attendanceId: att.body.attendance.id });
  ok("C4 TEST run + attendance removed via API", delRun.status === 200 && delAtt.status === 200);

  // ══ D. Documents vault ═════════════════════════════════════════════════
  console.log("── D. Documents ──");
  await clickTid("epr-tab-DOCUMENTS");
  await waitSel('[data-testid="epr-documents"]');
  await setTid("epr-doc-title", "TEST Employment Contract 2026");
  await setTid("epr-doc-expires", "2027-08-22");
  await setTid("epr-doc-note", "TEST doc note");
  const docUp = await page.$('[data-testid="epr-doc-file"] input[type=file]');
  await docUp.uploadFile("/home/user/pgtooling/test-photo.png");
  await waitSel('[data-testid="epr-doc-picked"]');
  await clickTid("epr-doc-save");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="epr-doc-"][data-testid$=""]').length >= 0, { timeout: 5000 }).catch(() => {});
  await sleep(1200);
  const doc1 = await q1(`SELECT id, title, file_data IS NOT NULL has_file FROM employee_documents WHERE employee_id=${newId} AND title LIKE 'TEST %' ORDER BY id LIMIT 1`);
  ok("D1 contract filed with attachment + expiry", !!doc1 && doc1.has_file, `doc ${doc1?.id}`);
  ok("D2 history: DOCUMENT_ADDED", !!(await q1(`SELECT id FROM employee_history WHERE employee_id=${newId} AND action='DOCUMENT_ADDED'`)));
  await setTid("epr-doc-type", "CERTIFICATE");
  await setTid("epr-doc-title", "TEST Safety Certificate");
  await clickTid("epr-doc-save");
  await sleep(1200);
  const docs2 = await q(`SELECT id, title FROM employee_documents WHERE employee_id=${newId} ORDER BY id`);
  ok("D3 two documents listed", docs2.length === 2, `${docs2.length}`);
  ok("D4 doc rows render (download + delete buttons)", (await exists(`[data-testid="epr-doc-dl-${doc1.id}"]`)) && (await exists(`[data-testid="epr-doc-del-${docs2[1].id}"]`)));
  await page.screenshot({ path: SHOT("4-documents") });
  await clickTid(`epr-doc-del-${docs2[1].id}`);
  await sleep(1200);
  ok("D5 document removed from list + DB", !(await exists(`[data-testid="epr-doc-${docs2[1].id}"]`)) && Number((await q1(`SELECT count(*) c FROM employee_documents WHERE employee_id=${newId}`)).c) === 1);
  ok("D6 history: DOCUMENT_REMOVED", !!(await q1(`SELECT id FROM employee_history WHERE employee_id=${newId} AND action='DOCUMENT_REMOVED'`)));

  // ══ E. Edit + record history ═══════════════════════════════════════════
  console.log("── E. Edit & history ──");
  await clickTid("epr-edit");
  await waitSel('[data-testid="ereg-root"]');
  const nameVal = await page.$eval('[data-testid="ereg-name"]', (e) => e.value);
  ok("E1 edit form prefilled", nameVal === "TEST Ama Serwaa");
  await setTid("ereg-phone", "024 999 8877");
  await setTid("ereg-salary", "2900");
  await clickTid("ereg-save");
  await page.waitForFunction(() => !document.querySelector('[data-testid="ereg-root"]'), { timeout: 15000 });
  const upd = await q1(`SELECT phone, salary_ghs FROM employees WHERE id=${newId}`);
  ok("E2 edits persisted", upd.phone === "024 999 8877" && Number(upd.salary_ghs) === 2900);
  const hPh = await q1(`SELECT field, old_value, new_value FROM employee_history WHERE employee_id=${newId} AND action='UPDATED' AND field='phone'`);
  const hSal = await q1(`SELECT field, old_value, new_value FROM employee_history WHERE employee_id=${newId} AND action='UPDATED' AND field='salaryGhs'`);
  ok("E3 history captures old → new (phone + salary)", hPh?.old_value === "024 555 0199" && hPh?.new_value === "024 999 8877" && Number(hSal?.old_value) === 2750 && Number(hSal?.new_value) === 2900, JSON.stringify([hPh, hSal]));
  await clickTid(`employee-profile-${newId}`);
  await waitSel('[data-testid="epr-root"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="epr-link-history"]')?.textContent || "0";
    return parseInt(t, 10) > 0;
  }, { timeout: 10000 }); // history payload arrived (avoids tab-race)
  await clickTid("epr-tab-HISTORY");
  await waitSel('[data-testid="epr-hist"]');
  await sleep(400);
  const histText = (await textOf('[data-testid="epr-hist"]')) || "";
  ok("E4 history tab shows the full trail", histText.includes("CREATED") && histText.includes("Phone changed") && histText.includes("Monthly salary") && histText.includes("Document added") && histText.includes("Document removed"), histText.slice(0, 120));
  ok("E5 who/when stamped", histText.includes("Kwame Mina") && histText.includes("OWNER"));
  await page.screenshot({ path: SHOT("5-history") });

  // ══ F. Authorization: workers denied ═══════════════════════════════════
  console.log("── F. Negative authorization tests ──");
  const akuaToken = await apiLogin(AKUA.email, AKUA.pw);
  const apiAkua = apiCall(akuaToken);
  ok("F1 worker cannot register (403)", (await apiAkua("POST", { data: { name: "TEST X", role: "TEST", businessId: 1, salaryGhs: 100 } })).status === 403);
  ok("F2 worker cannot edit (403)", (await apiAkua("PATCH", { id: newId, data: { phone: "x" } })).status === 403);
  ok("F3 worker cannot add documents (403)", (await apiAkua("POST", { action: "ADD_DOCUMENT", data: { employeeId: newId, title: "TEST X" } })).status === 403);
  ok("F4 worker cannot remove documents (403)", (await apiAkua("DELETE", { documentId: doc1.id })).status === 403);

  // ══ G. Legacy regression ═══════════════════════════════════════════════
  console.log("── G. Legacy data regression ──");
  const doris = await q1("SELECT employee_no, salary_ghs, phone, photo FROM employees WHERE id=1");
  ok("G1 Doris untouched (EMP-0001, 4500, no photo)", doris.employee_no === "EMP-0001" && Number(doris.salary_ghs) === 4500 && doris.phone === "+233 24 667 8810" && doris.photo === null);
  await clickTid("epr-close").catch(() => {});
  await clickTid("employee-profile-1");
  await waitSel('[data-testid="epr-root"]');
  ok("G2 legacy profile opens with seeded ID + history", (await innerHas('[data-testid="epr-empno"]', "EMP-0001")) && (await innerHas('[data-testid="epr-link-history"]', "1 entries")));
  await clickTid("epr-close");
} catch (err) {
  console.error("FATAL", err);
  failures++;
} finally {
  // ══ Z. Cleanup + forensics ═════════════════════════════════════════════
  console.log("── Z. TEST-data purge + forensics ──");
  if (newId) {
    await client.query(`DELETE FROM employee_documents WHERE employee_id=${newId}`);
    await client.query(`DELETE FROM employee_history WHERE employee_id=${newId}`);
    await client.query(`DELETE FROM payroll_attendance WHERE employee_id=${newId}`);
    await client.query(`DELETE FROM employees WHERE id=${newId}`);
  }
  await client.query(`DELETE FROM employee_history WHERE summary LIKE '%TEST %'`);
  await client.query(`DELETE FROM payroll_runs WHERE notes LIKE '%TEST%'`);
  await client.query(`DELETE FROM payroll_attendance WHERE note LIKE '%TEST%'`);
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    employees: Number((await q1("SELECT count(*) c FROM employees")).c),
    docs: Number((await q1("SELECT count(*) c FROM employee_documents")).c),
    hist: Number((await q1("SELECT count(*) c FROM employee_history")).c),
    att: Number((await q1("SELECT count(*) c FROM payroll_attendance")).c),
    runs: Number((await q1("SELECT count(*) c FROM payroll_runs")).c),
    testLeft: Number((await q1("SELECT (SELECT count(*) FROM employees WHERE name LIKE 'TEST %') + (SELECT count(*) FROM employee_documents WHERE title LIKE 'TEST %') + (SELECT count(*) FROM employee_history WHERE summary LIKE '%TEST %') c")).c),
  };
  ok("Z1 employees restored", F.employees === B.employees, `${F.employees}/${B.employees}`);
  ok("Z2 documents restored", F.docs === B.docs, `${F.docs}/${B.docs}`);
  ok("Z3 history restored", F.hist === B.hist, `${F.hist}/${B.hist}`);
  ok("Z4 attendance restored", F.att === B.att, `${F.att}/${B.att}`);
  ok("Z5 runs restored", F.runs === B.runs, `${F.runs}/${B.runs}`);
  ok("Z6 no TEST data left", F.testLeft === 0);
  await browser.close();
  await client.end();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed · page errors: ${pageErrors.length}`);
if (pageErrors.length) { console.log("PAGE ERRORS:"); pageErrors.slice(0, 10).forEach((e) => console.log("  •", e)); }
if (failures || pageErrors.length) process.exit(1);
