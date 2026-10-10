/**
 * EXPORT CENTER — module authorisation + real file delivery.
 *
 * The audit this suite pins:
 *   1. `/api/exports` authorises the MODULE, not just the act of exporting:
 *      • money modules (Command Center P&L, Enterprise Sales & Payments, the
 *        Financial Transactions ledger, payroll/budget/cash-flow/expense keys)
 *        need `canSeeFinancials` (OWNER / Super Admin / OWNER-authorised);
 *        without it only ONE unit the OWNER has delegated (businessManageIds)
 *        may be exported, never the enterprise-wide report.
 *      • the Enterprise Users directory needs `canSeeEnterpriseUsers`.
 *      • a NULL/absent `canExportData` is never a grant.
 *   2. The decision path is gated too: nobody approves, rejects or completes a
 *      sensitive export they are not authorised to see.
 *   3. A claimed unit scope is checked against real access.
 *   4. The Export Center really delivers a file — a UI click produces a PDF,
 *      CSV and XLSX on disk with the QR/audit metadata, and the audit row is
 *      written as COMPLETED (the earlier "no file lands" report was a probe
 *      artifact: an incognito browser context without browserContextId never
 *      receives downloads).
 *   5. An unauthorised viewer sees the restriction panel, not a submit button.
 *
 * Usage: bash dev-tooling/run-suite.sh dev-tooling/verify-export-center.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
// puppeteer-core lives in the shared /home/user/pgtooling workspace (see
// dev-tooling/verify-nav.mjs) — the app's own node_modules does not carry it.
const toolingRequire = createRequire("/home/user/pgtooling/package.json");
const puppeteer = toolingRequire("puppeteer-core");
const fs = await import("node:fs/promises");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const PG_URL = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const CHROMIUM = "/tmp/al2023/chromium";

const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", password: "GoMina@User2" };         // seeded WITH both grants
const BM = { email: "emmanuel@gomina360.com", password: "GoMina@User3" };         // biz 1, no grants

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n── ${t} ─────────────────────────────────────────`); }

async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; let text = "";
  try { text = await res.text(); json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGIN_GAP_MS = 2200; // the login route is IP-throttled at 30/minute
const loginBackoff = (attempt) => 12_000 * (attempt + 1);
let lastLoginAt = 0;
const login = async (c, label = "") => {
  const wait = LOGIN_GAP_MS - (Date.now() - lastLoginAt);
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; attempt < 4; attempt++) {
    lastLoginAt = Date.now();
    const r = await call("/api/auth/login", "POST", c);
    if (r.json?.sessionToken) return r.json.sessionToken;
    if (r.status !== 429 && !/too many/i.test(String(r.json?.error || ""))) return null;
    await sleep(loginBackoff(attempt));
  }
  console.error(`   (login throttled for ${label || c.email})`);
  return null;
};

const pg = new Client(PG_URL);
await pg.connect();

const TAG = `XCT${Date.now().toString(36).toUpperCase()}`;
// Every fixture address is `${TAG.toLowerCase()}.${who}@example-test.invalid`
// with TAG = XCT<base36>, so the prefix pattern must be `xct%` — a literal dot
// after "xct" matches nothing and would silently leave the run's accounts behind.
const EMAIL_LIKE = "xct%@example-test.invalid";
const email = (who) => `${TAG.toLowerCase()}.${who}@example-test.invalid`;

async function purge() {
  const ids = (await pg.query("SELECT id FROM users WHERE email LIKE $1", [EMAIL_LIKE])).rows.map((r) => Number(r.id));
  for (const id of ids) {
    for (const table of ["user_business_access", "organization_members", "user_sessions", "push_subscriptions"]) {
      try { await pg.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]); } catch { /* table shape */ }
    }
    try { await pg.query("DELETE FROM universal_exports WHERE requester_user_id = $1", [id]); } catch { /* FK */ }
  }
  await pg.query("DELETE FROM users WHERE email LIKE $1", [EMAIL_LIKE]);
  await pg.query("DELETE FROM universal_exports WHERE export_id LIKE 'XCT%'");
  await pg.query("DELETE FROM audit_trail WHERE target_label LIKE 'XCT%' OR detail LIKE 'XCT%'");
  // The seeded Branch Manager is the actor whose export toggle this suite
  // flips; rest the switch so an aborted run cannot leak state into the next.
  await pg.query("UPDATE users SET can_export_data = false WHERE email = $1", ["emmanuel@gomina360.com"]);
}
await purge();

// Baseline: every export row that exists before the run belongs to the demo
// data / another suite. Section Z removes only what this run created.
const uiExportIds = new Set();
const baselineExportId = Number((await pg.query("SELECT COALESCE(MAX(id), 0) AS m FROM universal_exports")).rows[0].m);
const OWNER_ID = Number((await pg.query("SELECT id FROM users WHERE email = $1", [OWNER.email])).rows[0].id);
const BIZ1 = Number((await pg.query("SELECT id FROM businesses ORDER BY id LIMIT 1")).rows[0].id);

const owner = await login(OWNER, "owner");
ok("login owner", !!owner);
const gm = await login(GM, "gm");
ok("login gm (seeded with both grants)", !!gm);
const bm = await login(BM, "bm");
ok("login bm", !!bm);

/* ── fixtures: one plain executive per sensitive role + a delegated manager ── */
const mkUser = async (who, role, extra = {}) =>
  call("/api/users", "POST", {
    name: `${TAG} ${who}`, email: email(who), phone: `055${Math.floor(1000000 + Math.random() * 8999999)}`,
    role, password: "Suite@Pass26", ...extra,
  }, owner);

const fx = {};
for (const [who, role] of [["gmplain", "GENERAL_MANAGER"], ["coowner", "CO_OWNER"], ["supervisor", "SUPERVISOR"]]) {
  // SUPERVISOR is a unit-scoped role (`requiresUnit` in the role registry — an
  // earlier audit finding), so the API refuses to create one without
  // `assignedBusinessId`. This fixture predates that rule and was passing
  // `extraAccessIds`, which the create handler does not read, so the user was
  // rejected with 400 and every export assertion that depended on it was
  // starved. The APP is right here; the fixture was stale.
  const created = await mkUser(who, role, role === "SUPERVISOR" ? { assignedBusinessId: BIZ1 } : {});
  fx[who] = { id: created.json?.user?.id ?? null, role };
  ok(`fixture created: ${who} (${role})`, !!fx[who].id, `${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  // The delegated manager gets the OWNER's explicit unit delegation + export toggle.
  if (who === "supervisor") {
    const patched = await call("/api/users", "PATCH", { userId: fx[who].id, businessManageIds: [BIZ1], canExportData: true }, owner);
    ok(`fixture delegated unit ${BIZ1} + canExportData`, patched.status === 200 && !!patched.json?.success, `${patched.status}`);
  }
  fx[who].token = await login({ email: email(who), password: "Suite@Pass26" }, who);
}
const starved = Object.entries(fx).filter(([, f]) => !f.token).map(([k]) => k);
if (starved.length) {
  console.log(`\n⛔ login throttle starved the run for: ${starved.join(", ")} — re-run in a minute.`);
  await purge(); await pg.end(); process.exit(1);
}

const mkExport = (token, moduleKey, extra = {}) =>
  call("/api/exports", "POST", {
    exportId: `${TAG}-${moduleKey}-${Math.floor(Math.random() * 1e7)}`,
    moduleKey, moduleLabel: moduleKey, format: "CSV", exportType: "REPORT", recordCount: 3, ...extra,
  }, token);

/* ── A · module authorisation ─────────────────────────────────────────── */
section("A · /api/exports module authorisation");

for (const mod of ["COMMAND_CENTER", "TRANSACTIONS", "USERS_MANAGE"]) {
  const r = await mkExport(owner, mod);
  ok(`owner · ${mod} export allowed (200)`, r.status === 200, `status=${r.status}`);
}
ok("gm (seeded grants) · TRANSACTIONS allowed", (await mkExport(gm, "TRANSACTIONS")).status === 200);
ok("gm (seeded grants) · USERS_MANAGE allowed", (await mkExport(gm, "USERS_MANAGE")).status === 200);
ok("gm (seeded grants) · COMMAND_CENTER allowed", (await mkExport(gm, "COMMAND_CENTER")).status === 200);

// A freshly created GM holds neither grant: operations yes, money/directory no.
ok("plain GM · CUSTOMERS export allowed (executive operations)", (await mkExport(fx.gmplain.token, "CUSTOMERS")).status === 200);
const gmPlainTx = await mkExport(fx.gmplain.token, "TRANSACTIONS");
ok("plain GM · TRANSACTIONS 403", gmPlainTx.status === 403, `status=${gmPlainTx.status}`);
ok("plain GM · COMMAND_CENTER 403", (await mkExport(fx.gmplain.token, "COMMAND_CENTER")).status === 403);
ok("plain GM · USERS_MANAGE 403", (await mkExport(fx.gmplain.token, "USERS_MANAGE")).status === 403);
ok("plain GM · PAYROLL_MAY 403 (finance key pattern)", (await mkExport(fx.gmplain.token, "PAYROLL_MAY")).status === 403);
ok("plain GM · denial names the OWNER grant", /OWNER/.test(String(gmPlainTx.json?.error || "")), String(gmPlainTx.json?.error));

ok("plain CO_OWNER · CUSTOMERS allowed", (await mkExport(fx.coowner.token, "CUSTOMERS")).status === 200);
ok("plain CO_OWNER · TRANSACTIONS 403", (await mkExport(fx.coowner.token, "TRANSACTIONS")).status === 403);
ok("plain CO_OWNER · USERS_MANAGE 403", (await mkExport(fx.coowner.token, "USERS_MANAGE")).status === 403);

// Delegated single-unit manager: their own unit's books yes, the group's no.
const unitScoped = await mkExport(fx.supervisor.token, "TRANSACTIONS", { businessId: BIZ1, businessName: "Unit" });
ok("delegated manager · unit-scoped TRANSACTIONS allowed", unitScoped.status === 200, `status=${unitScoped.status}`);
const enterpriseWide = await mkExport(fx.supervisor.token, "TRANSACTIONS", { businessId: null });
ok("delegated manager · enterprise-wide TRANSACTIONS 403", enterpriseWide.status === 403, `status=${enterpriseWide.status}`);
const foreignUnit = await mkExport(fx.supervisor.token, "CUSTOMERS", { businessId: 999999 });
ok("delegated manager · claimed unknown unit 403", foreignUnit.status === 403, `status=${foreignUnit.status}`);

// Branch Manager: the export toggle opens operational modules, never money or
// the directory, and a NULL/absent toggle is not a grant.
const bmId = Number((await pg.query("SELECT id FROM users WHERE email = $1", [BM.email])).rows[0].id);
const bmNoToggle = await mkExport(bm, "CUSTOMERS");
ok("bm without canExportData · any export 403", bmNoToggle.status === 403, `status=${bmNoToggle.status}`);
const bmGranted = await call("/api/users", "PATCH", { userId: bmId, canExportData: true }, owner);
ok("owner granted bm canExportData", bmGranted.status === 200);
ok("bm · CUSTOMERS allowed (branch operational)", (await mkExport(bm, "CUSTOMERS")).status === 200);
ok("bm · BRANCH_SALES allowed (branch operational)", (await mkExport(bm, "BRANCH_SALES")).status === 200);
ok("bm · EMPLOYEES roster allowed (no salary in payload)", (await mkExport(bm, "EMPLOYEES")).status === 200);
ok("bm · TRANSACTIONS 403 (money)", (await mkExport(bm, "TRANSACTIONS")).status === 403);
ok("bm · SALES_CENTER 403 (money)", (await mkExport(bm, "SALES_CENTER")).status === 403);
ok("bm · USERS_MANAGE 403 (directory)", (await mkExport(bm, "USERS_MANAGE")).status === 403);

// A NULL toggle must not read as a grant.
await pg.query("UPDATE users SET can_export_data = NULL WHERE id = $1", [bmId]);
await sleep(6500); // getSessionInfo holds a ~5s micro-cache of the user row
ok("bm · NULL canExportData is not a grant (403)", (await mkExport(bm, "CUSTOMERS")).status === 403);
await pg.query("UPDATE users SET can_export_data = true WHERE id = $1", [bmId]);
await sleep(6500);

// Decision path: approve / complete is gated on the record's module.
section("B · decisions on sensitive export records");
{
  const cc = await mkExport(owner, "COMMAND_CENTER");
  const ccId = cc.json?.export?.id;
  ok("owner · COMMAND_CENTER audit row created", !!ccId, JSON.stringify(cc.json).slice(0, 120));
  const bmComplete = await call("/api/exports", "PATCH", { id: ccId, action: "COMPLETE" }, bm);
  ok("bm cannot COMPLETE an owner money export (403)", bmComplete.status === 403, `status=${bmComplete.status}`);
  const gmPlainComplete = await call("/api/exports", "PATCH", { id: ccId, action: "COMPLETE" }, fx.gmplain.token);
  ok("plain GM cannot COMPLETE an owner money export (403)", gmPlainComplete.status === 403, `status=${gmPlainComplete.status}`);
  ok("owner can COMPLETE own money export (200)", (await call("/api/exports", "PATCH", { id: ccId, action: "COMPLETE" }, owner)).status === 200);

  // A pending money request inserted at the DB level cannot be approved by an
  // un-granted executive — the gate is not "who requested it".
  const [pend] = (await pg.query(
    `INSERT INTO universal_exports (export_id, module_key, module_label, export_type, format, requester_user_id,
       requester_name, requester_role, status, record_count, owner_id)
     VALUES ($1, 'TRANSACTIONS', 'Enterprise Financial Transactions', 'REPORT', 'CSV', $2, 'Suite', 'WORKER', 'PENDING', 1,
       (SELECT owner_id FROM businesses WHERE id = $3)) RETURNING id`,
    [`${TAG}-PENDING-TX`, fx.supervisor.id, BIZ1],
  )).rows;
  const gmPlainApprove = await call("/api/exports", "PATCH", { id: pend.id, action: "APPROVE" }, fx.gmplain.token);
  ok("plain GM cannot APPROVE a money request (403)", gmPlainApprove.status === 403, `status=${gmPlainApprove.status}`);
  const gmApprove = await call("/api/exports", "PATCH", { id: pend.id, action: "APPROVE" }, gm);
  ok("granted GM can APPROVE a money request (200)", gmApprove.status === 200, `status=${gmApprove.status}`);
  await pg.query("DELETE FROM universal_exports WHERE id = $1", [pend.id]);
}

/* ── C · real file delivery through the UI ────────────────────────────── */
section("C · Export Center delivers real files (owner, all three formats)");
const DL = "/tmp/xct-downloads";
await fs.rm(DL, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(DL, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROMIUM,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

async function signIn(page, creds) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.evaluate((c) => {
    const set = (t, v) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("login-email", c.email); set("login-password", c.password);
  }, creds);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 90000 });
  await sleep(2500);
}

const filesNow = async () => (await fs.readdir(DL).catch(() => [])).filter((f) => !f.endsWith(".crdownload"));
const waitForNewFile = async (before, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = await filesNow();
    const fresh = now.filter((f) => !before.includes(f));
    if (fresh.length) return fresh[0];
    await sleep(400);
  }
  return null;
};

async function generateExport(page, format) {
  await page.evaluate(() => document.querySelector('[data-testid="universal-export-btn"]')?.click());
  await page.waitForSelector('[data-testid="universal-export-modal"]', { timeout: 20000 });
  await sleep(500);
  await page.evaluate((f) => {
    const modal = document.querySelector('[data-testid="universal-export-modal"]');
    const btn = [...modal.querySelectorAll("button")].find((b) => b.textContent.trim() === f);
    btn?.click();
  }, format);
  await sleep(400);
  const before = await filesNow();
  await page.evaluate(() => document.querySelector('[data-testid="universal-export-submit-btn"]')?.click());
  const file = await waitForNewFile(before);
  // Success path closes the modal and clears the panel for the next run.
  await sleep(1200);
  return file;
}

{
  // Default context on purpose: an incognito BrowserContext needs
  // Browser.setDownloadBehavior({ browserContextId }) or nothing is ever saved.
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  const begun = [];
  client.on("Browser.downloadWillBegin", (e) => begun.push(e.suggestedFilename));
  await signIn(page, OWNER);

  for (const [format, ext] of [["PDF", "pdf"], ["CSV", "csv"], ["EXCEL", "xlsx"]]) {
    const file = await generateExport(page, format);
    ok(`ui export ${format} · file delivered`, !!file, `files=${JSON.stringify(await filesNow())}`);
    if (!file) continue;
    const size = (await fs.stat(`${DL}/${file}`)).size;
    ok(`ui export ${format} · non-empty file`, size > 1024, `${size} bytes`);
    ok(`ui export ${format} · extension .${ext}`, file.toLowerCase().endsWith(`.${ext}`), file);
    ok(`ui export ${format} · download event observed`, begun.includes(file), `begun=${JSON.stringify(begun)}`);
    // A PDF/XLSX must be the real thing, not an HTML error page saved as a file.
    const head = (await fs.readFile(`${DL}/${file}`)).subarray(0, 4);
    const magic = format === "PDF" ? head.toString("latin1").startsWith("%PDF")
      : format === "EXCEL" ? head[0] === 0x50 && head[1] === 0x4b
      : true; // CSV is text
    ok(`ui export ${format} · valid file signature`, magic, head.toString("latin1"));
  }

  const audit = await call(`/api/exports?userId=${OWNER_ID}`, "GET", null, owner);
  const recent = (audit.json?.exports || []).filter((r) => /^EXP-/.test(String(r.exportId || "")) && r.moduleKey === "COMMAND_CENTER");
  for (const r of recent) uiExportIds.add(Number(r.id));
  ok("ui exports recorded in the audit history", recent.length >= 3, `rows=${recent.length}`);
  ok("ui exports recorded as COMPLETED", recent.slice(0, 3).every((r) => r.status === "COMPLETED"), JSON.stringify(recent.slice(0, 3).map((r) => r.status)));
  await page.close();
}

/* ── D · worker request → approval → Download Approved ────────────────── */
section("D · worker export approval flow (request → approve → download)");
{
  // A shop worker needs the export toggle to submit at all, and — unlike a
  // Branch Manager — never gets a direct download: the request is PENDING
  // until an authorised executive approves it.
  // Created through Users & Access (the route that sets a password) — the
  // Branch-Manager /api/users/workers form deliberately creates the account
  // without credentials, so such a worker cannot sign in until a password is
  // set for them. The suite needs a signing-in worker, hence this route.
  const created = await call("/api/users", "POST", {
    name: `${TAG} worker`, email: email("worker"), phone: "0551234567",
    role: "WORKER", password: "Suite@Pass26", assignedBusinessId: BIZ1,
  }, owner);
  const workerId = created.json?.user?.id ?? created.json?.worker?.id ?? null;
  ok("fixture created: worker (biz 1)", !!workerId, `${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  const toggle = await call("/api/users", "PATCH", { userId: workerId, canExportData: true }, owner);
  ok("worker granted canExportData", toggle.status === 200);
  const workerToken = await login({ email: email("worker"), password: "Suite@Pass26" }, "worker");
  ok("worker can sign in", !!workerToken);

  // Same default context (downloads are allow-listed there) but the worker's
  // session. The bridge key is written directly instead of replaying the login
  // form: deterministic, and it keeps the login-throttle budget for section E.
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  // The token the bridge reads lives in sessionStorage; the httpOnly cookie
  // from the previous sign-in would otherwise win. Drop both, then inject.
  await client.send("Network.clearBrowserCookies");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => { sessionStorage.setItem("gomina_session_token", t); }, workerToken);
  await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 90000 });
  await sleep(2500);

  // 1) request — no file may be delivered at this point
  await page.evaluate(() => document.querySelector('[data-testid="universal-export-btn"]')?.click());
  await page.waitForSelector('[data-testid="universal-export-modal"]', { timeout: 20000 });
  await sleep(600);
  const label = await page.evaluate(() => document.querySelector('[data-testid="universal-export-submit-btn"]')?.textContent?.trim() || "");
  ok("worker · button asks for approval (not a download)", /approval/i.test(label), label);
  const beforeRequest = await filesNow();
  await page.evaluate(() => document.querySelector('[data-testid="universal-export-submit-btn"]')?.click());
  await sleep(2500);
  ok("worker request · no file delivered before approval", (await waitForNewFile(beforeRequest, 4000)) === null);

  const list = await call(`/api/exports?userId=${workerId}`, "GET", null, owner);
  const pending = (list.json?.exports || []).find((r) => r.status === "PENDING" && r.requesterUserId === workerId);
  ok("worker request · PENDING audit row recorded", !!pending, JSON.stringify((list.json?.exports || []).slice(0, 2)));
  ok("worker request · module is the worker workspace", pending?.moduleKey === "WORKER_DASHBOARD", String(pending?.moduleKey));
  if (pending) {
    // 2) a money module cannot be smuggled into a worker request
    const smuggle = await mkExport(workerToken, "TRANSACTIONS");
    ok("worker · TRANSACTIONS request denied (403)", smuggle.status === 403, `status=${smuggle.status}`);

    // 3) approve as the OWNER, then let the worker download the approved file
    const approved = await call("/api/exports", "PATCH", { id: pending.id, action: "APPROVE" }, owner);
    ok("owner approved the worker request", approved.status === 200 && approved.json?.export?.status === "APPROVED");

    await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 90000 });
    await sleep(2000);
    await page.evaluate(() => document.querySelector('[data-testid="universal-export-btn"]')?.click());
    await page.waitForSelector('[data-testid="universal-export-modal"]', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('[data-testid="universal-export-tab-audit"]')?.click());
    await sleep(1200);
    const beforeApproved = await filesNow();
    const clicked = await page.evaluate((exportId) => {
      const modal = document.querySelector('[data-testid="universal-export-modal"]');
      const row = [...modal.querySelectorAll("div")].find((d) => d.textContent?.includes(exportId) && d.querySelector("button"));
      const btn = row ? [...row.querySelectorAll("button")].find((b) => /download approved/i.test(b.textContent || "")) : null;
      btn?.click();
      return !!btn;
    }, pending.exportId);
    ok("worker · Download Approved button offered", clicked, `exportId=${pending.exportId}`);
    const file = await waitForNewFile(beforeApproved, 30000);
    ok("worker · approved export delivered as a file", !!file, `files=${JSON.stringify(await filesNow())}`);
    if (file) ok("worker · approved file non-empty", (await fs.stat(`${DL}/${file}`)).size > 1024, file);
    await sleep(1500);
    const after = await call(`/api/exports?userId=${workerId}`, "GET", null, owner);
    const row = (after.json?.exports || []).find((r) => r.exportId === pending.exportId);
    ok("worker export marked COMPLETED after download", row?.status === "COMPLETED", String(row?.status));
  }
  await page.close();
}

/* ── E · an unauthorised viewer sees the restriction, not a button ────── */
section("E · unauthorised viewer sees the restriction panel");
{
  // Fresh (incognito) context: the default context still holds the OWNER's
  // session, so the app would auto-sign-in and never render the login form.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await signIn(page, { email: email("gmplain"), password: "Suite@Pass26" });

  // Everyone lands on the Command Center (a money module), so the panel must
  // explain the restriction before anything is clicked.
  await page.evaluate(() => document.querySelector('[data-testid="universal-export-btn"]')?.click());
  await page.waitForSelector('[data-testid="universal-export-modal"]', { timeout: 20000 });
  await sleep(600);
  const state = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="universal-export-modal"]');
    const restricted = modal.querySelector('[data-testid="universal-export-restricted"]');
    return {
      restrictedText: restricted?.textContent?.trim() || null,
      hasSubmit: !!modal.querySelector('[data-testid="universal-export-submit-btn"]'),
    };
  });
  ok("plain GM · restriction panel shown", !!state.restrictedText);
  ok("plain GM · restriction names the OWNER grant", /OWNER/.test(String(state.restrictedText)));
  ok("plain GM · no generate button on a money module", state.hasSubmit === false);
  const before = await filesNow();
  await sleep(600);
  ok("plain GM · nothing downloaded", (await filesNow()).length === before.length);
  await ctx.close();
}

await browser.close();

/* ── Z · cleanup ──────────────────────────────────────────────────────── */
section("Z · cleanup");
// Restore the actor state explicitly, then remove only this run's rows: the
// tag-tagged API records, plus the owner's Command Center UI exports created
// after the high-water mark (that pair cannot collide with demo history).
const revert = await call("/api/users", "PATCH", { userId: bmId, canExportData: false }, owner);
ok("bm export toggle reverted to false", revert.status === 200);
await purge();
const apiRows = await pg.query("DELETE FROM universal_exports WHERE export_id LIKE $1 OR export_id LIKE $2", [`${TAG}%`, "%XCT%"]);
const uiRows = await pg.query(
  "DELETE FROM universal_exports WHERE id > $1 AND requester_user_id = $2 AND module_key = 'COMMAND_CENTER'",
  [baselineExportId, OWNER_ID],
);
console.log(`· removed ${apiRows.rowCount + uiRows.rowCount} export rows created by this run`);
const leftovers = (await pg.query("SELECT COUNT(*)::int AS c FROM users WHERE email LIKE $1", [EMAIL_LIKE])).rows[0].c;
ok("fixture users removed", leftovers === 0, `left=${leftovers}`);
const bmAfter = (await pg.query("SELECT can_export_data FROM users WHERE id = $1", [bmId])).rows[0].can_export_data;
ok("bm export toggle restored to false (db)", bmAfter === false, `value=${bmAfter}`);
await pg.end();

console.log(`\n${pass} pass / ${fail} fail`);
if (failures.length) { console.log("FAILED:\n  • " + failures.join("\n  • ")); process.exit(1); }
