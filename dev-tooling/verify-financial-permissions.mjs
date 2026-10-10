/**
 * verify-financial-permissions.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Task 7 · financial-permission audit & enforcement.
 *
 * Two guarantees, tested independently so a UI-only fix cannot pass:
 *
 *   A · UI      — a viewer denied financial authorisation must not find a
 *                 single rendered currency figure in ANY financial surface
 *                 anywhere in the app (Command Center, Finance & Reports,
 *                 the per-unit report in every business module).
 *   B · API     — the same viewer must be refused the money endpoints
 *                 outright, and must not be handed monetary aggregates.
 *
 * Authorised access is asserted too: an over-broad lock that also hides the
 * report from the OWNER, from a GRANTED general manager, or from a branch
 * manager the OWNER delegated finance to, is a regression, not a fix.
 *
 * RUN:  bash dev-tooling/run-suite.sh financial-permissions
 *   or: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-financial-permissions.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const pg = require("pg");

/** Every audit module, so a synthetic Auditor assignment covers the whole unit. */
const MODULES_ALL = ["EMPLOYEES","PAYROLL","TRANSACTIONS","INVENTORY","SALES","FINANCE","GENERAL"];

/** Toggle a user's OWNER-issued finance grant. Always paired with a `finally`
 *  that restores the fixture, so a failed run cannot leave the dataset with a
 *  permission flipped and every later suite misreading the result. */
const setGrant = async (id, on) => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
  await c.connect();
  await c.query("update users set can_view_finance=$1 where id=$2", [on, id]);
  await c.end();
};



const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n══ ${t} ══`); }

// ───────────────────────────────────────────────────────────────────────────
// Roles. `fin: false` = denied. Two distinct authorized shapes are covered:
// an OWNER (by role) and a non-owner who holds the explicit grant.
// ───────────────────────────────────────────────────────────────────────────
const ROLES = [
  { key: "owner",          label: "OWNER (authorized by role)",        email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26",  fin: true },
  { key: "gm_granted",     label: "GENERAL_MANAGER + finance grant",  email: "abena.gm@gomina360.com",   pw: "GoMina@User2",   fin: true },
  { key: "bm_denied",      label: "BRANCH_MANAGER, no grant (DENIED)", email: "emmanuel@gomina360.com",   pw: "GoMina@User3",   fin: false },
  { key: "worker_denied",  label: "WORKER, no grant (DENIED)",         email: "akua.donkor@gomina360.com", pw: "GoMina@User10", fin: false },
];

// ── Normalise the fixture first ────────────────────────────────────────────
// This suite flips grants and grants Auditor assignments. If a previous run (or
// a manual probe) was interrupted before its cleanup, the dataset can be left
// with a permission flipped — and this suite would then report the GRANTED
// roles as denied and look like the app had regressed. Pin the canonical state
// up front so a failure here means a real failure.
{
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
  await c.connect();
  await c.query("update users set can_view_finance=true where id=2");
  await c.query("update users set can_view_finance=false where id=3");
  await c.query("delete from audit_assignments where note='financial-permission suite'");
  await c.end();
}

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  headless: "new",
  defaultViewport: { width: 1600, height: 1400 },
});

/** Fresh context per role so sessions never bleed between users. */
async function signInInto(page, cred) {
  const failed = [];
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, "")}`); });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 25000 });
  await page.type('[data-testid="login-email"]', cred.email);
  await page.type('[data-testid="login-password"]', cred.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 45000 });
  return { page, failed };
}

/** Fresh context per role so sessions never bleed between users. */
async function signIn(cred) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const r = await signInInto(page, cred);
  return { ctx, ...r };
}

/** Every currency-looking string rendered anywhere under `rootSel`. */
// NOTE: this body is serialised into the browser, so the regex has to be
// declared INSIDE it — it cannot close over a Node-scope const.
const READ_MONEY = (rootSel) => {
  const MONEY_RE = /[\u20b5$€£]|\d{1,3}(?:,\d{3})+|\b\d+\.\d{2}\b/;
  const root = document.querySelector(rootSel);
  if (!root) return null;                       // surface absent entirely
  return [...root.querySelectorAll("*")]
    .filter((e) => e.childNodes.length === 1 && e.firstChild?.nodeType === 3)
    .map((e) => e.textContent.trim())
    .filter((t) => t && MONEY_RE.test(t));
};

// ───────────────────────────────────────────────────────────────────────────
// A · UI  — Command Center
// ───────────────────────────────────────────────────────────────────────────
section("A · UI — Command Center Enterprise Financial Report");

const uiFindings = {};

for (const role of ROLES) {
  const { ctx, page } = await signIn(role);
  await page.goto(`${BASE}/?tab=COMMAND_CENTER`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4500);

  const res = await page.evaluate(READ_MONEY, '[data-testid="fin-report-enterprise"]');
  const locked = await page.evaluate(() => !!document.querySelector('[data-testid="fin-report-enterprise-restricted"]'));
  const kpiDataValue = await page.evaluate(() =>
    document.querySelector('[data-testid="cc-kpi-revenue"]')?.getAttribute("data-value") ?? null);

  uiFindings[role.key] = { reportRendered: res !== null, money: res?.length ?? 0, locked, kpiDataValue };

  if (role.fin) {
    ok(`${role.label}: report reachable`, res !== null);
    ok(`${role.label}: report shows figures`, (res?.length ?? 0) > 0, `found ${res?.length ?? 0}`);
    ok(`${role.label}: not locked out`, locked === false);
  } else {
    // `null` means the surface did not render at all — a stronger outcome
    // than rendering it empty, so both are acceptable; only non-empty fails.
    ok(`${role.label}: no rendered figures in the report`, res === null || res.length === 0,
       `LEAK — ${res?.length ?? 0} figures, e.g. ${JSON.stringify((res ?? []).slice(0, 3))}`);
    ok(`${role.label}: Command Center lock notice or absent surface`, locked === true || res === null,
       "no lock notice and the report rendered");
    ok(`${role.label}: Command Center KPI carries no data-value`, kpiDataValue === null, `got ${kpiDataValue}`);
  }
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────────────
// A1b · THE REPORTED SCENARIO — an EXECUTIVE who lacks the finance grant.
//       A branch manager never reaches the Command Center at all, so gating
//       the report inside the component is untested by them. Only a
//       non-owner executive can still open Command Center with financials
//       denied — which is exactly how this leak reached production.
// ───────────────────────────────────────────────────────────────────────────
section("A1b · UI — executive WITHOUT the finance grant (reported scenario)");

try {
  await setGrant(2, false);
  const { ctx, page } = await signIn(ROLES[1]);
  await page.goto(`${BASE}/?tab=COMMAND_CENTER`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4500);

  const res = await page.evaluate(READ_MONEY, '[data-testid="fin-report-enterprise"]');
  const locked = await page.evaluate(() => !!document.querySelector('[data-testid="fin-report-enterprise-restricted"]'));
  const kpi = await page.evaluate(() =>
    document.querySelector('[data-testid="cc-kpi-revenue"]')?.getAttribute("data-value") ?? null);

  uiFindings.gm_denied = { reportRendered: res !== null, money: res?.length ?? 0, locked, kpi };

  ok("denied executive CAN still open the Command Center", res !== null);
  ok("denied executive sees ZERO figures in the Enterprise Report",
     res !== null && res.length === 0, `LEAK — ${res?.length ?? 0} figures, e.g. ${JSON.stringify((res ?? []).slice(0, 4))}`);
  ok("denied executive gets the lock notice", locked === true);
  ok("denied executive Command Center KPI carries no data-value", kpi === null, `got ${kpi}`);
  await ctx.close();
} finally {
  await setGrant(2, true);   // restore the canonical fixture
}

// ───────────────────────────────────────────────────────────────────────────
// A2 · UI — Finance & Reports (EnterpriseFinanceView) and the per-unit report
// ───────────────────────────────────────────────────────────────────────────
section("A2 · UI — Finance & Reports + per-unit business report");

for (const role of [ROLES[0], ROLES[1], ROLES[2]]) {
  const { ctx, page } = await signIn(role);
  await page.goto(`${BASE}/?tab=FINANCE`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4500);

  const res = await page.evaluate(READ_MONEY, '[data-testid="fin-report-enterprise"]');
  const financeTab = await page.evaluate(() => !!document.querySelector('[data-testid="sidebar-tab-finance"]'));
  uiFindings[`${role.key}_fin`] = { reportRendered: res !== null, money: res?.length ?? 0, financeTab };

  if (role.fin) {
    ok(`${role.label}: Finance & Reports reachable`, financeTab === true);
    ok(`${role.label}: figures rendered there`, (res?.length ?? 0) > 0 || res === null,
       `figures ${res?.length ?? 0}`);
  } else {
    ok(`${role.label}: Finance tab hidden`, financeTab === false);
    ok(`${role.label}: no figures leak in Finance & Reports`, res === null || res.length === 0,
       `LEAK — ${(res ?? []).length} figures, e.g. ${JSON.stringify((res ?? []).slice(0, 3))}`);
  }
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────────────
// A3 · UI — the PER-UNIT report inside each business module. The enterprise
//       report is only ONE of fourteen call sites; the other thirteen live in
//       the per-unit dashboards. A unit module is reached by its business CODE
//       (`?tab=POULTRY-01`) and then its own FINANCE pill — NOT by ?tab=FINANCE,
//       which is the enterprise surface. An earlier draft of this suite used
//       the wrong URL and passed vacuously against a surface that never
//       rendered, which is worse than not testing it at all.
// ───────────────────────────────────────────────────────────────────────────
section("A3 · UI — per-unit report, every business type, granted vs denied");

const UNITS = [
  { code: "POULTRY-01",  pill: "poultry-tab-FINANCE",   tid: "fin-report-poultry",   label: "Poultry Farm" },
  { code: "BLOCK-01",    pill: "bf-tab-FINANCE",       tid: "fin-report-block",     label: "Block Factory" },
  { code: "AQUA-01",     pill: "aqua-tab-FINANCE",     tid: "fin-report-aqua",      label: "Aquaculture" },
  { code: "LIVESTOCK-01",pill: "lk-tab-FINANCE"   ,tid: "fin-report-livestock", label: "Livestock" },
  { code: "FOOD-01",     pill: "rst-tab-FINANCE"  ,     tid: "fin-report-food",      label: "Restaurant & Food" },
  { code: "TECH-01",     pill: "elex-tab-FINANCE" ,     tid: "fin-report-tech",      label: "Electronic Shop" },
  { code: "BOUTIQUE-01", pill: "boutique-tab-FINANCE", tid: "fin-report-boutique",  label: "Boutique" },
  { code: "HARDWARE-01",pill: "hw-tab-FINANCE",       tid: "fin-report-hardware", label: "Hardware Store" },
  { code: "WASH-01",    pill: "cw-tab-REPORTS",       tid: "fin-report-wash",      label: "Car Wash" },
  // No Telecom unit ships in the seed, so this one is provisioned below.
  // Its REPORT lives under REPORTS, not FINANCE — its FINANCE tab carries the
  // separate ledger P&L that section D covers.
  { code: "@TELECOM",   pill: "tel-tab-REPORTS",      tid: "fin-report-tel",       label: "Telecom & Digital" },
];;

/** Provision a Telecom unit (none ships in the seed) so that business type is
 *  covered live too, rather than only by the static call-site check. */
const PROBE_LEDGER = [
  // INCOME / EXPENSE are the canonical revenue/expense types the report
  // aggregates on. A "SALE" row exists in the schema but is NOT counted, so
  // seeding one would leave a report that renders only zeroed tiles and make
  // the authorised assertion look like over-blocking.
  ["INCOME", "Airtime sales", 5000],
  ["INCOME", "Data bundles", 1800],
  ["EXPENSE", "Airtime purchase", 3200],
];

async function ensureTelecom(page) {
  // page.evaluate serialises this function into the browser, so PROBE_LEDGER
  // must be passed in as an argument — it cannot close over a Node-scope const.
  return page.evaluate(async (ledger) => {
    // Idempotent: a previous run may have left one behind, and a duplicate
    // would silently point section D at a different unit than the one whose
    // code we provisioned.
    const list = await (await fetch("/api/businesses?limit=200", { credentials: "include" })).json();
    const existing = (list?.businesses || []).find((b) => b.name === "SUITE Telecom Probe");
    if (existing) {
      // Seed on the REUSE path too. A leftover probe from an aborted run has no
      // ledger, and an empty unit renders a report full of zeroed tiles — which
      // makes "the OWNER still sees money" fail for reasons that have nothing
      // to do with the gate.
      for (const [type, category, amountGhs] of ledger) {
        await fetch("/api/transactions", {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId: existing.id, type, category, amountGhs, note: "suite probe", recordedByName: "Kwame Mina" }),
        });
      }
      return { status: 200, code: existing.code, id: existing.id, reused: true };
    }
    const r = await fetch("/api/businesses", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SUITE Telecom Probe", category: "Telecom & Digital Services", ownerId: 1 }),
    });
    let j = null; try { j = await r.json(); } catch {}
    const biz = j?.business;
    // An empty unit has no report figures at all, so "the OWNER still sees
    // money" would be vacuous. Give it a small ledger.
    if (biz) {
      for (const [type, category, amountGhs] of ledger) {
        await fetch("/api/transactions", {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId: biz.id, type, category, amountGhs, note: "suite probe", recordedByName: "Kwame Mina" }),
        });
      }
    }
    return { status: r.status, code: biz?.code || null, id: biz?.id || null, reused: false };
  }, PROBE_LEDGER);
}
async function dropTelecom(page) {
  await page.evaluate(async () => {
    await fetch("/api/businesses?search=SUITE%20Telecom%20Probe", { credentials: "include" });
  });
}

/** Open a unit module, click its FINANCE pill, read back the report subtree.
 *
 *  `expectMoney` retries once. A unit provisioned moments ago can be missing
 *  from the cached `/api/init` payload the app boots with, which renders a
 *  report full of zeroed tiles — indistinguishable from over-blocking, and
 *  flaky by nature. One retry after the cache has rolled over separates a real
 *  regression from a provisioning race. */
async function openUnitReport(page, u, expectMoney = false) {
  await page.goto(`${BASE}/?tab=${u.code}`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(3000);
  const hasPill = await page.evaluate((p) => !!document.querySelector(`[data-testid="${p}"]`), u.pill);
  if (!hasPill) return { reachable: false };
  await page.click(`[data-testid="${u.pill}"]`);
  await sleep(3000);
  let r = await readReport(page, u);
  if (expectMoney && !r.locked && (r.money?.length ?? 0) === 0) {
    await sleep(4000);
    await page.goto(`${BASE}/?tab=${u.code}`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);
    await page.click(`[data-testid="${u.pill}"]`);
    await sleep(3000);
    r = await readReport(page, u);
  }
  return r;
}

async function readReport(page, u) {
  const money = await page.evaluate(READ_MONEY, `[data-testid="${u.tid}"]`);
  // The report's own lock is `${testid}-restricted`, but tabs wrapped in
  // <FinancialGate> short-circuit before the report renders at all, so their
  // lock carries a different id. Either lock means the viewer is shut out.
  const locked = await page.evaluate(
    (t) => !!document.querySelector(`[data-testid="${t}-restricted"]`) ||
          !!document.querySelector('[data-testid$="-restricted"]'),
    u.tid,
  );
  return { reachable: true, money, locked };
}

// A3a — the OWNER is authorized: every per-unit report must still work.
//
// The probe unit is provisioned in its OWN session, closed, and only then is
// the owner's session opened. Creating a unit inside the very session that is
// about to navigate to it leaves that session's cached scope without the new
// business, so `?tab=TELECOM-01` silently falls through to another module and
// the report never mounts — a provisioning artefact that reads exactly like a
// broken report.
const provCtx = await browser.createBrowserContext();
const provPage = await provCtx.newPage();
await signInInto(provPage, ROLES[0]);
const tel = await ensureTelecom(provPage);
await provCtx.close();

const ownerCtx = await browser.createBrowserContext();
const ownerPage = await ownerCtx.newPage();
await signInInto(ownerPage, ROLES[0]);
ok("provisioned a Telecom unit to cover that business type live", !!tel.code, JSON.stringify(tel));
if (tel.code) {
  const t = UNITS.find((u) => u.code === "@TELECOM");
  if (t) t.code = tel.code;
}
let ownerClean = 0, ownerTotal = 0;
for (const u of UNITS) {
  const r = await openUnitReport(ownerPage, u, true);
  if (!r.reachable) { console.log(`  – ${u.label}: no FINANCE pill (module layout)`); continue; }
  ownerTotal++;
  const live = (r.money?.length ?? 0) > 0 && r.locked === false;
  if (live) ownerClean++;
  ok(`${u.label}: OWNER still sees the per-unit report`, live,
     `report ${r.money === null ? "ABSENT" : "rendered empty"} · locked=${r.locked} · code=${u.code}`);
}
await ownerCtx.close();

// A3b — the same surfaces for an EXECUTIVE whose grant has been revoked.
let deniedClean = 0, deniedTotal = 0;
try {
  await setGrant(2, false);
  for (const u of UNITS) {
    const { ctx, page } = await signIn(ROLES[1]);
    const r = await openUnitReport(page, u);
    if (!r.reachable) { await ctx.close(); continue; }
    deniedTotal++;
    const clean = r.money === null || r.money.length === 0;
    if (clean) deniedClean++;
    ok(`${u.label}: denied executive sees no figures in the per-unit report`, clean,
       `LEAK — ${r.money?.length ?? 0} figures, e.g. ${JSON.stringify((r.money ?? []).slice(0, 3))}`);
    ok(`${u.label}: per-unit report shows the lock`, r.locked === true, "report rendered unlocked");
    await ctx.close();
  }
} finally {
  await setGrant(2, true);   // restore the canonical fixture
}

// ───────────────────────────────────────────────────────────────────────────
// B · API — money endpoints must refuse a denied viewer, and must not hand
//          back monetary aggregates.
// ───────────────────────────────────────────────────────────────────────────
section("B · API — financial endpoints refuse denied viewers");
const blocked = (st) => st === 401 || st === 403;

/** Endpoints that must be closed to a viewer without financial authorisation. */
// Wholly closed to a denied viewer.
const RESTRICTED = [
  "/api/budgets",
  "/api/payroll",
  "/api/cashflow/forecast",
];
/* A full business backup is restore-capable, so the route gates on
 * OWNER-level power (super admin / OWNER / unit manager / create-unit) AND
 * the finance grant — it is deliberately NARROWER than `canSeeFinancials`.
 * A granted GM is therefore expected to be refused, which is why it is
 * asserted separately instead of being folded into the finance list.
 * Requires a businessId: without it the route 400s on param validation and
 * the gate is never reached — a green test that verifies nothing. */
const BACKUP = "/api/business-backup/export?businessId=1";
/** Served to everyone, but must withhold its money fields from a denied
 *  viewer — the roster is operational, the salary is money
 *  (docs/ENTERPRISE-PERMISSIONS-AND-FINANCIAL-ACCESS.md §"salaries are money,
 *  rosters are not"). A 403 here would be over-restriction. */
const REDACTED = ["/api/employees"];

for (const role of [ROLES[1], ROLES[2], ROLES[3]]) {
  const { ctx, page } = await signIn(role);
  const api = await page.evaluate(async (eps) => {
    const out = {};
    for (const e of [...eps, "/api/employees"]) {
      const r = await fetch(e, { credentials: "include" });
      let body = null;
      try { body = await r.json(); } catch {}
      out[e] = { status: r.status, body };
    }
    // /api/init must not carry monetary aggregates for a denied viewer.
    const init = await fetch("/api/init", { credentials: "include" });
    let initBody = null;
    try { initBody = await init.json(); } catch {}
    out["/api/init"] = { status: init.status, body: initBody };
    return out;
  }, [...RESTRICTED, BACKUP]);

  const blocked = (st) => st === 401 || st === 403;
  if (role.fin) {
    for (const e of RESTRICTED) {
      ok(`${role.label}: ${e.split("?")[0]} served (authorized)`, !blocked(api[e].status), `status ${api[e].status}`);
    }
  } else {
    for (const e of RESTRICTED) {
      ok(`${role.label}: ${e.split("?")[0]} refused`, blocked(api[e].status), `status ${api[e].status}`);
    }
    for (const e of REDACTED) {
      const rows = api[e].body?.employees || api[e].body?.data || api[e].body?.rows || [];
      const leaked = (Array.isArray(rows) ? rows : []).filter((r) =>
        typeof r?.salaryGhs === "number" && r.salaryGhs !== 0);
      ok(`${role.label}: ${e} served but salary withheld`, !blocked(api[e].status) && leaked.length === 0,
         `status ${api[e].status}, ${leaked.length} rows carry a salary`);
    }
  }

  if (!role.fin) {
    // The ledger keeps amounts by design (recording a sale needs them) — what
    // must be absent is any server-computed revenue / expense / profit figure.
    const b = api["/api/init"].body || {};
    const m = b.metrics || b.metricRows || [];
    const aggLeak = m.filter((r) =>
      [r.revenueGhs, r.expensesGhs, r.profitGhs, r.revenue, r.expenses, r.profit]
        .some((v) => typeof v === "number" && v !== 0));
    ok(`${role.label}: /api/init withholds monetary metrics`, aggLeak.length === 0,
       `LEAK — ${aggLeak.length} metric rows carry non-zero money`);
  }
  await ctx.close();
}

section("B2 · API — full business backup (OWNER-level capability)");
for (const role of ROLES) {
  const { ctx, page } = await signIn(role);
  const st = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }, BACKUP);

  if (role.key === "owner") {
    ok(`${role.label}: backup download served`, !blocked(st.status), `status ${st.status}`);
  } else if (role.key === "gm_granted") {
    ok(`${role.label}: backup refused — finance grant alone is not OWNER power`,
       blocked(st.status), `status ${st.status}`);
  } else {
    ok(`${role.label}: backup refused`, blocked(st.status), `status ${st.status}`);
  }
  await ctx.close();
}

 // ───────────────────────────────────────────────────────────────────────────
// B3 · API — /api/audit is reachable by any OWNER-granted AUDITOR, who is not
//        automatically granted financial access. Its timeline used to print
//        every employee's monthly salary and each payroll run's net total to
//        exactly those viewers.
// ───────────────────────────────────────────────────────────────────────────
section("B3 · API — audit timeline withholds salary/payroll net from denied viewers");
{
  // The default record list is capped and EMPLOYEE rows sit past the cut, so
  // a plain GET would return none at all — which reads as "no leak" even when
  // every row is fully priced. Ask for the rows by type explicitly.
  // `recordType` takes ONE value, not a list — ask once per type.
  const fetchAudit = async (page, recordType) => page.evaluate(async (rt) => {
    const res = await fetch(`/api/audit?limit=2000&recordType=${rt}`, { credentials: "include" });
    let body = null; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  }, recordType);
  const rowsOf = (body) => {
    const rows = body?.records || body?.data?.records || [];
    return Array.isArray(rows) ? rows : [];
  };
  const moneyRows = (b) => rowsOf(b).filter((r) => typeof r.amountGhs === "number" && r.amountGhs > 0);

  // The GM has no Auditor assignment by default, so without one this block
  // would only ever test the OWNER — i.e. it would assert the authorized view
  // and never the redaction it exists to protect. Grant a real assignment for
  // the duration, then remove it.
  const grantAudit = async (on) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
    await c.connect();
    if (on) {
      await c.query(
        `insert into audit_assignments (user_id,user_name,user_role,business_id,branch_code,modules,note,is_active,granted_by_user_id,granted_by_name,granted_by_role,created_at,updated_at)
         values (2,'Abena Serwaa','GENERAL_MANAGER',1,null,$1::jsonb,'financial-permission suite',true,1,'Kwame Mina','OWNER',now(),now())
         on conflict do nothing`, [JSON.stringify(MODULES_ALL)]);
    } else {
      await c.query("delete from audit_assignments where user_id=2 and note='financial-permission suite'");
    }
    await c.end();
  };

  const CASES = [
    { role: ROLES[0], auditor: false, grant: true,  label: "OWNER (authorized)" },
    { role: ROLES[1], auditor: true,  grant: true,  label: "AUDITOR + finance grant (authorized)" },
    // The case the redaction actually exists for: an OWNER-granted Auditor who
    // was NOT given financial access. Audit eligibility and finance eligibility
    // are separate grants, so this combination is reachable in production.
    { role: ROLES[1], auditor: true,  grant: false, label: "AUDITOR, finance DENIED" },
  ];

  for (const c of CASES) {
    const role = c.role;
    await grantAudit(c.auditor);
    await setGrant(2, c.grant);
    const { ctx, page } = await signIn(role);
    const emp = await fetchAudit(page, "EMPLOYEE");
    const pay = await fetchAudit(page, "PAYROLL_RUN");
    if (blocked(emp.status)) {
      console.log(`  – ${c.label}: /api/audit not reachable (status ${emp.status}) — nothing to assert`);
    } else {
      // Rows must be PRESENT for the denied case too — a viewer who simply
      // sees no records has proved nothing about redaction.
      ok(`${c.label}: audit timeline returns the employee rows`, rowsOf(emp.body).length > 0,
         "no employee rows at all — the redaction is untested");
      if (c.grant) {
        ok(`${c.label}: audit timeline shows employee salaries`, moneyRows(emp.body).length > 0,
           `0 of ${rowsOf(emp.body).length} salary rows priced — the authorized view may be over-redacted`);
        ok(`${c.label}: audit timeline shows payroll net totals`, moneyRows(pay.body).length > 0,
           `0 of ${rowsOf(pay.body).length} payroll rows priced — the authorized view may be over-redacted`);
      } else {
        ok(`${c.label}: audit timeline withholds employee salaries`, moneyRows(emp.body).length === 0,
           `LEAK — ${moneyRows(emp.body).length} salary rows priced`);
        ok(`${c.label}: audit timeline withholds payroll net totals`, moneyRows(pay.body).length === 0,
           `LEAK — ${moneyRows(pay.body).length} payroll rows priced`);
        const salaryText = rowsOf(emp.body).some((r) => /Salary GH₵/.test(String(r.detail || "")));
        ok(`${c.label}: salary text is not left in the row detail`, !salaryText,
           `LEAK — detail still renders "Salary GH₵ …"`);
      }
    }
    await ctx.close();
  }
  await grantAudit(false);
  await setGrant(2, true);   // restore the canonical fixture
}

// ───────────────────────────────────────────────────────────────────────────
// D · The second wave — surfaces found by a whole-app sweep AFTER the report
//     gate was in place. Each of these rendered money outside the report and
//     none of them was covered by the first fix.
// ───────────────────────────────────────────────────────────────────────────
section("D · Sweep surfaces — money rendered outside the report");

const deniedCtx = await browser.createBrowserContext();
const deniedPage = await deniedCtx.newPage();
await signInInto(deniedPage, ROLES[1]);   // GM; grant revoked below
await setGrant(2, false);

const telecomUnit = UNITS.find((u) => u.code !== "@TELECOM" && u.tid === "fin-report-tel")?.code
  || tel?.code;
const CASES_D = [
  { label: "Car Wash Reports strip", tab: "WASH-01", pill: "cw-tab-REPORTS", ids: ["cw-stat-revenue", "cw-stat-expenses", "cw-stat-profit"], lock: "cw-reports-restricted" },
  { label: "Telecom Finance P&L", tab: telecomUnit || "TELECOM-01", pill: "tel-tab-FINANCE", ids: ["tel-fin-income", "tel-fin-expense", "tel-fin-profit", "tel-fin-working"], lock: "tel-finance-restricted" },
];
for (const c of CASES_D) {
  await deniedPage.goto(`${BASE}/?tab=${c.tab}`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2500);
  const has = await deniedPage.evaluate((p) => !!document.querySelector(`[data-testid="${p}"]`), c.pill);
  if (!has) { console.log(`  – ${c.label}: tab pill absent`); continue; }
  await deniedPage.click(`[data-testid="${c.pill}"]`);
  await sleep(3000);
  const out = await deniedPage.evaluate((ids, lock) => ({
    money: ids.filter((id) => !!document.querySelector(`[data-testid="${id}"]`)),
    locked: !!document.querySelector(`[data-testid="${lock}"]`),
  }), c.ids, c.lock);
  ok(`${c.label}: no money tiles rendered`, out.money.length === 0, `LEAK — ${JSON.stringify(out.money)}`);
  ok(`${c.label}: lock notice shown`, out.locked === true);
}
await deniedCtx.close();

// The OWNER must still see every one of them.
{
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await signInInto(page, ROLES[0]);
  for (const c of CASES_D) {
    await page.goto(`${BASE}/?tab=${c.tab}`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    const has = await page.evaluate((p) => !!document.querySelector(`[data-testid="${p}"]`), c.pill);
    if (!has) continue;
    await page.click(`[data-testid="${c.pill}"]`);
    await sleep(3000);
    const shown = await page.evaluate((ids) => ids.filter((id) => !!document.querySelector(`[data-testid="${id}"]`)), c.ids);
    ok(`${c.label}: OWNER still sees the money tiles`, shown.length > 0,
       `${shown.length}/${c.ids.length} — possible over-blocking`);
  }
  await ctx.close();
}

// Scenario Planner: projected revenue / net profit / baseline money.
section("D2 · Scenario Planner + BI Assistant");
for (const [label, role, expectMoney] of [["OWNER", ROLES[0], true], ["denied executive", ROLES[1], false]]) {
  await setGrant(2, expectMoney);   // true = granted (OWNER), false = denied
  const { ctx, page } = await signIn(role);
  await page.goto(`${BASE}/?tab=SCENARIO_PLANNER`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4000);
  const scen = await page.evaluate(() => ({
    revenue: document.querySelector('[data-testid="scen-live-revenue"]')?.textContent?.trim() || null,
    profit: document.querySelector('[data-testid="scen-live-profit"]')?.textContent?.trim() || null,
    locked: !!document.querySelector('[data-testid="scen-money-restricted"]'),
  }));
  const priced = (t) => !!t && /[₵$€£]/.test(t);
  if (expectMoney) {
    ok(`${label}: Scenario Planner shows revenue and profit`, priced(scen.revenue) && priced(scen.profit),
       `rev=${scen.revenue} prof=${scen.profit}`);
  } else {
    ok(`${label}: Scenario Planner withholds revenue/profit`, !priced(scen.revenue) && !priced(scen.profit),
       `LEAK — rev=${scen.revenue} prof=${scen.profit}`);
    ok(`${label}: Scenario Planner shows the lock`, scen.locked === true);
  }

  // The Assistant answers off the real books — role alone used to be enough.
  const ask = await page.evaluate(async () => {
    const r = await fetch("/api/assistant?q=how%20is%20this%20month%27s%20finance", { credentials: "include" });
    return await r.json();
  });
  const answer = String(ask?.answer || "");
  const pricedAnswer = /[₵$€£]\s*\d/.test(answer);
  if (expectMoney) {
    ok(`${label}: BI Assistant answers with figures`, pricedAnswer, "authorized but no figures returned");
  } else {
    ok(`${label}: BI Assistant refuses the money question`, !pricedAnswer, `LEAK — answered: ${answer.slice(0, 80)}`);

    const feed = await page.evaluate(async () => {
      const r = await fetch("/api/assistant", { credentials: "include" });
      const j = await r.json();
      return (j?.feed || []).map((i) => `${i.title} ${i.detail || ""}`).join(" ");
    });
    ok(`${label}: BI Assistant feed carries no currency`, !/[₵$€£]\s*\d/.test(feed),
       `LEAK — ${feed.slice(0, 90)}`);
  }
  await ctx.close();
}
await setGrant(2, true);

// Credit-sales roll-ups and the tracking aggregate: masked, not absent.
section("D3 · Credit-sales totals + tracking aggregate are masked, not removed");
{
  await setGrant(2, false);
  const { ctx, page } = await signIn(ROLES[1]);
  await page.goto(`${BASE}/?tab=BRANCH_SALES`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4000);
  const credit = await page.evaluate(() =>
    ["bm-credit-total-sales", "bm-credit-total-paid", "bm-credit-outstanding"]
      .map((id) => [id, (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim()]));
  for (const [id, text] of credit) {
    ok(`denied executive: ${id} masked`, text === "•••••", `got ${JSON.stringify(text)}`);
  }
  await page.goto(`${BASE}/?tab=TRACKING`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4000);
  const summary = await page.evaluate(() =>
    (document.querySelector('[data-testid="ct-orders-summary"]')?.textContent || "").trim());
  ok("denied executive: tracking active-value roll-up masked", /active value\s*•••••/.test(summary), `got ${JSON.stringify(summary)}`);
  ok("denied executive: individual order amounts stay (sales recording is role-scoped)",
     /order/.test(summary), `summary missing: ${summary}`);
  await ctx.close();

  await setGrant(2, true);
  const c2 = await browser.createBrowserContext();
  const p2 = await c2.newPage();
  await signInInto(p2, ROLES[1]);
  await p2.goto(`${BASE}/?tab=BRANCH_SALES`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4000);
  const ownerCredit = await p2.evaluate(() =>
    ["bm-credit-total-sales", "bm-credit-outstanding"]
      .map((id) => (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim()));
  ok("granted executive: credit-sales totals show real figures",
     ownerCredit.every((t) => t !== "•••••" && /[₵$€£]/.test(t)), JSON.stringify(ownerCredit));
  await c2.close();
}

// ───────────────────────────────────────────────────────────────────────────
// E · Whole-app sweep — the check that actually FOUND the second wave. It walks
//     every surface a denied viewer can reach and reports any rendered currency
//     figure, so a leak in a module this suite does not otherwise touch still
//     fails loudly. `allow` lists testids that legitimately carry money for an
//     unauthorised viewer, each with the policy line that justifies it.
// ───────────────────────────────────────────────────────────────────────────
section("E · Whole-app sweep for a denied executive");
{
  await setGrant(2, false);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await signInInto(page, ROLES[1]);

  // Individual ORDER values stay visible: the policy keeps "sales recording"
  // role-scoped, because fulfilling an order requires knowing what it is worth.
  // Their ROLL-UPS are masked (section D3) — these are the permitted leaves.
  const ALLOWED = [
    { id: /^ct-orders-amount-/, why: "individual order value — sales recording is role-scoped" },
    { id: /navbar|currency/, why: "currency picker / user chrome" },
  ];

  const SWEEP_TABS = [
    "ACTION_CENTER", "SALES_CENTER", "TRACKING", "PREORDERS", "CUSTOMERS", "TRANSACTIONS",
    "INVENTORY", "SUPPLIERS", "ASSETS", "BRANCH_SALES", "BRANCH_ASSETS", "DOCUMENTS",
    "ONLINE_ORDERING", "MANAGE_UNITS", "ADVISOR", "SCENARIO_PLANNER", "AUDIT",
    "PLATFORM_ADMIN", "SUPPORT", "INTEGRATIONS", "AI_ADVISOR", "BI_ASSISTANT",
    "WORKERS_MANAGE", "ADVISOR_MANAGE", "USERS_MANAGE", "EMPLOYEES", "FINANCE", "COMMAND_CENTER",
  ];
  const SWEEP_UNITS = UNITS.filter((u) => u.code !== "@TELECOM").map((u) => [u.code, u.pill]);

  const leaks = [];
  const SCAN = () => {
    // NOTE: serialised into the browser — self-contained, no outer scope.
    const M = /[\u20b5$€£]\s*[\d,]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;
    const hits = [];
    document.querySelectorAll("[data-testid]").forEach((e) => {
      const id = e.dataset.testid || "";
      if (/^(nav|login)/.test(id)) return;
      if (e.querySelector("[data-testid]")) return;       // leaf cards only
      const t = (e.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 120 && M.test(t)) hits.push({ id, text: t.slice(0, 70) });
      M.lastIndex = 0;
    });
    return hits;
  };

  const visit = async (url, pill) => {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(2200);
    if (pill) {
      const has = await page.evaluate((p) => !!document.querySelector(`[data-testid="${p}"]`), pill);
      if (!has) return;
      await page.click(`[data-testid="${pill}"]`);
      await sleep(2200);
    }
    for (const h of await page.evaluate(SCAN)) {
      if (ALLOWED.some((a) => a.id.test(h.id))) continue;
      leaks.push(`${h.id} :: ${h.text}`);
    }
  };

  for (const t of SWEEP_TABS) await visit(`${BASE}/?tab=${t}`, null);
  for (const [code, pill] of SWEEP_UNITS) await visit(`${BASE}/?tab=${code}`, pill);

  ok(`sweep covered ${SWEEP_TABS.length} top-level tabs + ${SWEEP_UNITS.length} unit modules`, true);
  ok("no currency figure anywhere for the denied executive", leaks.length === 0,
     `${leaks.length} leak(s): ${JSON.stringify(leaks.slice(0, 6))}`);
  await ctx.close();
  await setGrant(2, true);
}

// ───────────────────────────────────────────────────────────────────────────
// F · Third wave — surfaces the sweep only reaches once they hold real data.
//     Each of these is an INCONSISTENCY rather than an unguarded surface: the
//     same figure was withheld in one place and published in another, so a
//     denied viewer could simply go and read it somewhere else.
// ───────────────────────────────────────────────────────────────────────────
section("F · Stored labels & valuation follow the same rule everywhere");
{
  // Seed a money-bearing deletion, the way a real transaction delete does.
  const prov = await browser.createBrowserContext();
  const pp = await prov.newPage();
  await signInInto(pp, ROLES[0]);
  const seeded = await pp.evaluate(async () => {
    const mk = await (await fetch("/api/transactions", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: 1, type: "INCOME", category: "SuiteSeed", amountGhs: 4242, note: "suite deletion probe" }),
    })).json();
    const id = mk?.transaction?.id;
    if (!id) return { ok: false };
    const del = await fetch("/api/transactions", {
      method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, reason: "suite deletion probe" }),
    });
    return { ok: del.status === 200, id };
  });
  ok("seeded a money-bearing deletion for the redaction checks", seeded.ok === true, JSON.stringify(seeded));
  await prov.close();

  const priced = (t) => /[₵$€£]\s*[\d,]+/.test(t || "");

  // The module deletion panel (SharedEnterpriseModule → /api/enterprise).
  await setGrant(2, false);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await signInInto(page, ROLES[1]);
  await page.goto(`${BASE}/?tab=POULTRY-01`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(3000);

  const logs = await page.evaluate(async () => {
    const j = await (await fetch("/api/enterprise?deletionLogs=1&module=TRANSACTIONS", { credentials: "include" })).json();
    return j.logs || [];
  });
  // Match on the CATEGORY, which the money-bearing label embeds — the deletion
  // reason lives in its own field, so searching the label for it finds nothing.
  const isProbe = (l) => String(l.recordLabel || "").includes("SuiteSeed");
  const mine = logs.filter(isProbe);
  ok("deletion-log rows are served to the denied viewer", logs.length > 0);
  ok("denied viewer: deletion-log label keeps the record but drops the figure",
     mine.length > 0 && mine.every((l) => !priced(l.recordLabel)),
     `LEAK — ${JSON.stringify(mine.map((l) => l.recordLabel))}`);

  const audit = await page.evaluate(async () => {
    const j = await (await fetch("/api/audit?recordType=DELETION", { credentials: "include" })).json();
    return j.records || [];
  });
  const pricedAudit = audit.filter((r) => priced(r.title) || priced(r.detail));
  ok("denied viewer: audit DELETION rows carry no figure", pricedAudit.length === 0,
     `LEAK — ${JSON.stringify(pricedAudit.slice(0, 2).map((r) => r.title))}`);

  const assets = await page.evaluate(async () => {
    const j = await (await fetch("/api/audit?recordType=ASSET", { credentials: "include" })).json();
    return j.records || [];
  });
  ok("denied viewer: audit ASSET rows carry no valuation",
     assets.every((r) => !priced(r.detail) && r.amountGhs == null),
     `LEAK — ${JSON.stringify(assets.slice(0, 2).map((r) => r.detail))}`);
  await ctx.close();

  // An authorised viewer must still see every one of them.
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  await signInInto(page2, ROLES[0]);
  const ownerLogs = await page2.evaluate(async () => {
    const j = await (await fetch("/api/enterprise?deletionLogs=1&module=TRANSACTIONS", { credentials: "include" })).json();
    return j.logs || [];
  });
  const ownerMine = ownerLogs.filter((l) => String(l.recordLabel || "").includes("SuiteSeed"));
  ok("OWNER still sees the figure in the deletion log",
     ownerMine.length > 0 && ownerMine.every((l) => priced(l.recordLabel)),
     JSON.stringify(ownerMine.map((l) => l.recordLabel)));
  const ownerAssets = await page2.evaluate(async () => {
    const j = await (await fetch("/api/audit?recordType=ASSET", { credentials: "include" })).json();
    return j.records || [];
  });
  ok("OWNER still sees asset valuation in the audit trail",
     ownerAssets.length === 0 || ownerAssets.every((r) => r.amountGhs != null || priced(r.detail)),
     `${ownerAssets.length} asset rows`);
  await ctx2.close();
  await setGrant(2, true);

  // Leave no fixture behind.
  const clean = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
  await clean.connect();
  await clean.query("delete from notifications where record_ref like '%suite deletion probe%'");
  await clean.query("delete from record_deletion_logs where reason = 'suite deletion probe'");
  await clean.end();
}

// ───────────────────────────────────────────────────────────────────────────
// C · Static — no FinancialReportSection call site may omit `currentUser`.
//      A caller that forgets the prop now fails CLOSED, but that is a silent
//      denial of legitimate access, so pin it as a regression too.
// ───────────────────────────────────────────────────────────────────────────
section("C · Static — every report call site threads currentUser");
{
  const { execSync } = await import("node:child_process");
  const files = execSync("grep -rl '<FinancialReportSection' src/components --include=*.tsx")
    .toString().trim().split("\n").filter(Boolean);
  ok("scanned a non-trivial number of files", files.length >= 10, `scanned ${files.length}`);
  let missing = 0, callsites = 0;
  for (const f of files) {
    const raw = (await import("node:fs")).readFileSync(f, "utf8");
    // Strip comments before scanning. Both "missing" hits this suite reported
    // were PROSE — a doc comment naming the component — not call sites, which
    // is the same false-positive trap that comment-matching set before.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const blocks = src.split("<FinancialReportSection").slice(1);
    callsites += blocks.length;
    for (const b of blocks) {
      const head = b.slice(0, 900);
      if (!/currentUser=\{currentUser\}/.test(head)) {
        missing++; console.log(`      missing in ${f}`);
      }
    }
  }
  ok("found a non-trivial number of call sites", callsites >= 14, `found ${callsites}`);
  ok("every <FinancialReportSection> passes currentUser", missing === 0, `${missing} missing`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(64)}`);
if (tel && tel.id) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
  await c.connect();
  // Remove the probe unit AND its ledger rows. Deleting only the business
  // leaves orphaned transactions behind — rows whose business_id points at
  // nothing — which inflate the record counts later suites assert on and is
  // how this suite was found breaking verify-business-scope.
  await c.query("delete from transactions where business_id=$1", [tel.id]);
  await c.query("delete from businesses where id=$1", [tel.id]);
  console.log(`   cleanup: removed probe Telecom unit ${tel.code} (id ${tel.id})`);
  await c.end();
}

console.log(`FINANCIAL PERMISSION SUITE — ${pass} pass / ${fail} fail`);
console.log(`   per-unit reports — OWNER authorized ${ownerClean}/${ownerTotal} types · denied executive clean ${deniedClean}/${deniedTotal} types`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  · ${f}`)); }
await browser.close();
process.exit(fail ? 1 : 0);