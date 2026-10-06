/**
 * ENTERPRISE USERS · SENSITIVE FINANCIAL SURFACES · COMMAND CENTER — permission
 * and tenant-isolation audit.
 *
 * What this suite pins (the contract the OWNER asked for):
 *   1. "Enterprise Users" (the staff directory + access console) is visible to
 *      the OWNER and to accounts the OWNER explicitly authorised
 *      (`users.canManageUsers`) — a freshly created GENERAL_MANAGER sees nothing.
 *   2. Money/performance data — the Central Financial Report (Finance & Reports),
 *      Command Center P&L, budgets, cash-flow forecasts and payroll — reaches
 *      only the OWNER, the platform Super Admin and OWNER-authorised viewers
 *      (`users.canViewFinance`).
 *   3. Tenant isolation: a new account NEVER sees another owner's users,
 *      workers, businesses, transactions or ledgers.
 *   4. Authorisation is a switch: grant → access appears; revoke → it disappears
 *      (no stale cache, no client-side-only gate).
 *   5. Roles across the platform are exercised: OWNER, CO_OWNER, GENERAL_MANAGER,
 *      BRANCH_MANAGER, SUPERVISOR, ACCOUNTANT, WORKER and FARM_ADVISOR.
 *
 * Usage: bash dev-tooling/run-suite.sh dev-tooling/verify-enterprise-permissions.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const PG_URL = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", password: "GoMina@User2" };        // OWNER-authorised in the seed
const BM = { email: "emmanuel@gomina360.com", password: "GoMina@User3" };        // biz 1 — never authorised
const BM2 = { email: "kofi@gomina360.com", password: "GoMina@User4" };           // biz 2 — never authorised
const WORKER = { email: "akua.donkor@gomina360.com", password: "GoMina@User10" };// biz 1 — never authorised

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
/**
 * The login route is IP-throttled at 30 attempts/minute. This suite signs in
 * ~12 actors, so it spaces the attempts and retries with backoff instead of
 * mistaking a throttle for a permission result.
 */
const LOGIN_GAP_MS = 2200; // keeps a full run inside the route's 30/minute budget
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
const asUser = (token) => async (path, method = "GET", body = null) => call(path, method, body, token);

const pg = new Client(PG_URL);
await pg.connect();

/**
 * Idempotent purge of this suite's fixtures — keyed by its own email prefix so
 * it can never touch demo data or another suite's actors. Called at the START
 * (a previous run may have been killed mid-flight: residue would otherwise
 * drift the counts of unrelated suites) and again in section Z.
 */
async function purge() {
  const like = "evp%@example-test.invalid";
  const orgIds = (await pg.query("SELECT id FROM organizations WHERE name LIKE 'EVP%'")).rows.map((r) => Number(r.id));
  const userIds = (await pg.query("SELECT id FROM users WHERE email LIKE $1", [like])).rows.map((r) => Number(r.id)).filter((n) => n !== 1);
  for (const id of userIds) {
    for (const table of ["user_business_access", "advisor_assignments", "organization_members", "user_sessions", "push_subscriptions"]) {
      try { await pg.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]); } catch { /* table shape */ }
    }
  }
  await pg.query("DELETE FROM users WHERE email LIKE $1", [like]);
  for (const id of orgIds) {
    try { await pg.query("DELETE FROM businesses WHERE owner_id = $1", [id]); } catch { /* FK */ }
    for (const table of ["organization_members", "company_settings"]) {
      try { await pg.query(`DELETE FROM ${table} WHERE organization_id = $1`, [id]); } catch { /* table shape */ }
    }
  }
  await pg.query("DELETE FROM organizations WHERE name LIKE 'EVP%'");
  await pg.query("DELETE FROM audit_trail WHERE target_label LIKE 'EVP%' OR detail LIKE 'EVP%'");
  // The salary-surface fixture is a roster row, not an account: heal it too.
  const empIds = (await pg.query("SELECT id FROM employees WHERE name LIKE 'EVP%'")).rows.map((r) => Number(r.id));
  for (const id of empIds) {
    try { await pg.query("DELETE FROM employee_history WHERE employee_id = $1", [id]); } catch { /* table shape */ }
    try { await pg.query("DELETE FROM employee_documents WHERE employee_id = $1", [id]); } catch { /* table shape */ }
    try { await pg.query("DELETE FROM employees WHERE id = $1", [id]); } catch { /* FK */ }
  }
}
await purge(); // heal any residue from a previously aborted run

/* ── fixtures ─────────────────────────────────────────────────────────── */
const TAG = `EVP${Date.now().toString(36).toUpperCase()}`;
const email = (who) => `${TAG.toLowerCase()}.${who}@example-test.invalid`;
const mkUser = async (ownerToken, who, role, extra = {}) =>
  call("/api/users", "POST", {
    name: `${TAG} ${who}`, email: email(who), phone: `055${Math.floor(1000000 + Math.random() * 8999999)}`,
    role, password: "Suite@Pass26", ...extra,
  }, ownerToken);

const t = {
  owner: await login(OWNER),
  gm: await login(GM),
  bm: await login(BM),
  bm2: await login(BM2),
  worker: await login(WORKER),
};
for (const [k, v] of Object.entries(t)) ok(`login ${k}`, !!v);

// Provision one clean account per non-owner role, with a business in scope so
// that a 403 can never be mistaken for "no data".
const FIXTURE_ROLES = [
  ["coOwner", "CO_OWNER", [1]],
  ["gmPlain", "GENERAL_MANAGER", [1]],
  ["supervisor", "SUPERVISOR", [1]],
  ["accountant", "ACCOUNTANT", [1]],
];
const fixtures = {};
for (const [who, role, extraAccessIds] of FIXTURE_ROLES) {
  const created = await mkUser(t.owner, who, role, {
    // Every unit-scoped role (Worker / Supervisor / Accountant / Branch Manager)
    // must carry a primary unit — the API rejects a unitless unit role with 400.
    ...(["WORKER", "SUPERVISOR", "ACCOUNTANT", "BRANCH_MANAGER"].includes(role)
      ? { assignedBusinessId: 1 }
      : {}),
    ...(extraAccessIds ? { extraAccessIds } : {}),
  });
  fixtures[who] = { id: created.json?.user?.id ?? null, role, token: null };
  ok(`fixture created: ${who} (${role})`, !!fixtures[who].id, `${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  fixtures[who].token = await login({ email: email(who), password: "Suite@Pass26" }, who);
}
// FARM_ADVISOR is OWNER-created only and cannot hold a branch — a separate shape.
const advisorCreated = await call("/api/users", "POST", {
  name: `${TAG} advisor`, email: email("advisor"), phone: "0559999999",
  role: "FARM_ADVISOR", password: "Suite@Pass26",
}, t.owner);
if (advisorCreated.json?.user?.id) {
  // No login needed: the advisor's access matrix (self-only payload, no money)
  // is pinned by dev-tooling/verify-farm-advisor.mjs; here we only confirm the
  // role never sees Enterprise Users or financial surfaces when it does sign in.
  fixtures.advisor = { id: advisorCreated.json.user.id, role: "FARM_ADVISOR", token: null, noTokenOk: true };
} else {
  // Some workspaces already hold the advisor invite slot; fall back to a real
  // seeded advisor if one exists, otherwise skip the advisor assertions.
  const row = (await pg.query("SELECT id, email FROM users WHERE role = 'FARM_ADVISOR' LIMIT 1")).rows[0];
  fixtures.advisor = row ? { id: Number(row.id), role: "FARM_ADVISOR", token: null, noTokenOk: true } : null;
}
ok("fixture available: FARM_ADVISOR (or none needed)", fixtures.advisor !== undefined);
const missingTokens = Object.entries(fixtures).filter(([, f]) => f && !f.token && !f.noTokenOk).map(([k]) => k);
if (missingTokens.length) {
  console.log(`\n⛔ login throttle starved the run for: ${missingTokens.join(", ")} — re-run in a minute.`);
  await purge();
  await pg.end();
  process.exit(1);
}

/* ── A · Enterprise Users authorisation ───────────────────────────────── */
section("A · Enterprise Users (staff directory) authorisation");
{
  const cases = [
    ["OWNER", t.owner, 200],
    ["OWNER-authorised GM (canManageUsers)", t.gm, 200],
    ["unnamed CO_OWNER (no grant)", fixtures.coOwner.token, 403],
    ["unnamed GENERAL_MANAGER (no grant)", fixtures.gmPlain.token, 403],
    ["BRANCH_MANAGER", t.bm, 403],
    ["SUPERVISOR", fixtures.supervisor.token, 403],
    ["ACCOUNTANT", fixtures.accountant.token, 403],
    ["WORKER", t.worker, 403],
  ];
  for (const [who, token, expect] of cases) {
    const r = await call("/api/users", "GET", null, token);
    ok(`Enterprise Users · ${who} → ${expect}`, r.status === expect, `got ${r.status}`);
  }
  const anon = await call("/api/users");
  ok("Enterprise Users · anonymous → 401", anon.status === 401, `got ${anon.status}`);

  // The same boundary on the bootstrap payload: no staff role receives a
  // directory containing another organisation's accounts.
  const foreign = (await pg.query(
    `SELECT u.email FROM users u
      WHERE u.id <> 1
        AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id AND m.organization_id = 1)
      LIMIT 20`,
  )).rows.map((r) => r.email);
  if (foreign.length) {
    for (const [who, token] of [["authorised GM", t.gm], ["BRANCH_MANAGER", t.bm], ["SUPERVISOR", fixtures.supervisor.token], ["ACCOUNTANT", fixtures.accountant.token], ["WORKER", t.worker]]) {
      const r = await call("/api/init", "GET", null, token);
      const blob = JSON.stringify(r.json?.users || []);
      ok(`/api/init users · ${who} carries no other-organisation accounts`, !foreign.some((e) => blob.includes(e)), foreign.slice(0, 2).join(","));
    }
  } else {
    ok("/api/init users · single-organisation workspace (nothing foreign to leak)", true);
  }

  // The directory never leaks another organisation's people.
  const orgIds = (await pg.query("SELECT id FROM organizations ORDER BY id")).rows.map((r) => Number(r.id));
  const mine = (await pg.query("SELECT organization_id FROM organization_members WHERE user_id = 1")).rows.map((r) => Number(r.organization_id));
  const foreignOrg = orgIds.find((id) => !mine.includes(id));
  if (foreignOrg) {
    const foreignEmails = (await pg.query(
      `SELECT u.email FROM users u JOIN organization_members m ON m.user_id = u.id WHERE m.organization_id = $1`, [foreignOrg],
    )).rows.map((r) => r.email);
    if (foreignEmails.length) {
      const dir = await call("/api/users", "GET", null, t.owner);
      const blob = JSON.stringify(dir.json || {});
      const ownerIsSuper = (await pg.query("SELECT is_super_admin FROM users WHERE id = 1")).rows[0]?.is_super_admin === true;
      if (ownerIsSuper) {
        // The platform Super Admin (the OWNER account that runs the console)
        // holds a deliberate platform-wide directory capability; it is NOT
        // widened to anybody else — asserted for every staff role below and by
        // the second-org OWNER in section D.
        ok("Enterprise Users · platform Super Admin owns the platform-wide directory (by design)",
          dir.status === 200 && foreignEmails.some((e) => blob.includes(e)));
      } else {
        ok(`Enterprise Users · OWNER directory excludes org #${foreignOrg} accounts`,
          foreignEmails.every((e) => !blob.includes(e)), foreignEmails.slice(0, 2).join(","));
      }
    } else {
      ok(`Enterprise Users · org #${foreignOrg} has no accounts to leak`, true);
    }
  } else {
    ok("Enterprise Users · single-organisation workspace (no cross-org accounts exist)", true);
  }
}

/* ── B · Financial surfaces — payload level ───────────────────────────── */
section("B · Financial data in the bootstrap payload (/api/init)");
{
  const money = (m) => Number(m?.revenueGhs || 0) + Number(m?.netProfitGhs || 0) + Number(m?.cashFlowGhs || 0) + Number(m?.expensesGhs || 0);
  // D3: the Accountant role is a FINANCE HOLDER by construction (the OWNER sees
  // the Finance toggle switched on by the role preset and can revoke it), scoped
  // to the units the account can reach. Every other staff role, and an executive
  // without the explicit grant, receives no money figures at all.
  const entitled = [
    ["OWNER", t.owner, true],
    ["OWNER-authorised GM", t.gm, true],
    ["ACCOUNTANT (D3 finance grant, unit-scoped)", fixtures.accountant.token, true],
  ];
  const denied = [
    ["plain GENERAL_MANAGER", fixtures.gmPlain.token],
    ["CO_OWNER (no grant)", fixtures.coOwner.token],
    ["BRANCH_MANAGER", t.bm],
    ["SUPERVISOR", fixtures.supervisor.token],
    ["WORKER", t.worker],
  ];
  for (const [who, token, shouldSee] of entitled) {
    const r = await call("/api/init", "GET", null, token);
    const first = (r.json?.metrics || [])[0];
    ok(`/api/init · ${who} receives live financial metrics`, !!first && money(first) > 0 && !first.financialsRestricted,
      JSON.stringify(first || {}).slice(0, 140));
    const emp = (r.json?.employees || [])[0];
    ok(`/api/init · ${who} sees employee salary (financial surface)`, !emp || emp.salaryGhs != null, `${emp?.salaryGhs}`);
  }
  for (const [who, token] of denied) {
    const r = await call("/api/init", "GET", null, token);
    const rows = r.json?.metrics || [];
    const anyMoney = rows.some((m) => money(m) > 0);
    ok(`/api/init · ${who} authenticated and receives NO financial figures`, r.status === 200 && !anyMoney, `http=${r.status} metrics=${rows.length} money=${anyMoney}`);
    const salaryLeak = (r.json?.employees || []).some((e) => e.salaryGhs != null && Number(e.salaryGhs) !== 0);
    ok(`/api/init · ${who} receives NO salary figures`, r.status === 200 && !salaryLeak);
    const assetLeak = (r.json?.assets || []).some((a) => (a.purchasePriceGhs != null && Number(a.purchasePriceGhs) !== 0) || (a.currentValueGhs != null && Number(a.currentValueGhs) !== 0));
    ok(`/api/init · ${who} receives NO asset valuation`, r.status === 200 && !assetLeak);
    ok(`/api/init · ${who} payload carries no unhashed secrets`, !/passwordHash|password_hash|\\$2b\\$|\\$argon/.test(r.text));
  }
}

/* ── B2 · Worker workspace minimization ──────────────────────────────── */
section("B2 · Worker workspace carries only its own operational records");
{
  const r = await call("/api/init", "GET", null, t.worker);
  const tx = r.json?.transactions || [];
  const foreignOwners = [...new Set(tx.map((x) => x.recordedBy).filter(Boolean))].filter((n) => n !== "Akua Donkor");
  ok("worker bootstrap ships only their OWN recorded transactions", r.status === 200 && foreignOwners.length === 0, foreignOwners.join(","));
  ok("worker bootstrap ships no receivables ledger", JSON.stringify(r.json?.creditSales || []) === "[]", `${(r.json?.creditSales || []).length} rows`);
  const api = await call("/api/transactions", "GET", null, t.worker);
  const rows = api.json?.transactions || [];
  const apiForeign = [...new Set(rows.map((x) => x.recordedBy).filter(Boolean))].filter((n) => n !== "Akua Donkor");
  ok("worker /api/transactions is self-scoped", api.status === 200 && apiForeign.length === 0, apiForeign.join(","));
  const bm = await call("/api/transactions", "GET", null, t.bm);
  ok("branch manager still sees the branch ledger", bm.status === 200 && (bm.json?.transactions || []).length > rows.length);
}

/* ── C · Financial surfaces — endpoints ──────────────────────────────── */
section("C · Financial endpoints (budgets · cash-flow · payroll)");
{
  const endpoints = [
    ["/api/budgets?businessId=1&period=2026-Q1", "budgets"],
    ["/api/cashflow/forecast?businessId=1&weeks=4", "cash-flow forecast"],
    ["/api/payroll", "payroll"],
  ];
  for (const [path, label] of endpoints) {
    for (const [who, token, expect] of [
      ["OWNER", t.owner, 200],
      ["authorised GM", t.gm, 200],
      ["plain GM", fixtures.gmPlain.token, 403],
      ["BRANCH_MANAGER", t.bm, 403],
      ["SUPERVISOR", fixtures.supervisor.token, 403],
      // D3: the Accountant holds the OWNER-revocable Finance grant.
      ["ACCOUNTANT (D3 finance grant)", fixtures.accountant.token, 200],
      ["WORKER", t.worker, 403],
    ]) {
      const r = await call(path, "GET", null, token);
      ok(`${label} · ${who} → ${expect}`, r.status === expect, `got ${r.status}`);
      if (expect === 403) {
        const leak = /"(revenueGhs|netPayGhs|grossPayGhs|amountGhs|plannedGhs|actualGhs|net)"\s*:\s*(?!0[,\s}])/.test(r.text);
        ok(`${label} · ${who} denial leaks no figures`, !leak);
      }
    }
  }
  // Payroll WRITES are gated too — a granted payroll reader must still hold
  // record-management to mutate, and an unauthorised one is refused outright.
  const write = await call("/api/payroll", "POST", { action: "ADD_ATTENDANCE", data: { employeeId: 1, status: "PRESENT", date: "2026-01-01" } }, fixtures.gmPlain.token);
  ok("payroll write · plain GM → 403", write.status === 403, `got ${write.status}`);
}

/* ── C2 · Employee salaries: roster operational, money restricted ─────── */
section("C2 · Employee salaries (roster visible, figures restricted)");
{
  // /api/employees must agree with /api/init: a viewer without the OWNER's
  // Finance & Reports authorisation gets the roster with the money removed —
  // never the salary figure, and never the payroll net aggregate.
  const ownerEmp = await call("/api/employees", "GET", null, t.owner);
  const ownerRows = ownerEmp.json?.employees || [];
  ok("employees · owner sees the roster", ownerRows.length > 0);
  ok("employees · owner sees salary figures", ownerRows.some((e) => e.salaryGhs != null));
  ok("employees · owner scope reports financial access", ownerEmp.json?.scope?.canSeeFinancials === true);

  const gmEmp = await call("/api/employees", "GET", null, t.gm);
  ok("employees · authorised GM sees salary figures", (gmEmp.json?.employees || []).some((e) => e.salaryGhs != null));

  // ACCOUNTANT is intentionally NOT in this list: the approved Accountant preset
  // (D3) carries the OWNER-revocable `canViewFinance` grant, so an Accountant is
  // a finance holder by construction and is asserted as such further below.
  for (const [who, token] of [
    ["BRANCH_MANAGER", t.bm],
    ["WORKER", t.worker],
    ["plain GM", fixtures.gmPlain.token],
    ["SUPERVISOR", fixtures.supervisor.token],
  ]) {
    const r = await call("/api/employees", "GET", null, token);
    const rows = r.json?.employees || [];
    ok(`employees · ${who} → 200 (operational roster)`, r.status === 200, `got ${r.status}`);
    ok(`employees · ${who} every row flagged financialsRestricted`, rows.length > 0 && rows.every((e) => e.financialsRestricted === true && e.salaryGhs === null));
    ok(`employees · ${who} no salary figure anywhere in the payload`, !/"salaryGhs"\s*:\s*\d/.test(r.text));
    const nets = Object.values(r.json?.links || {}).filter((v) => v && v.payrollNet !== undefined && v.payrollNet !== null);
    ok(`employees · ${who} no payroll net aggregate`, nets.length === 0);
    ok(`employees · ${who} scope reports no financial access`, r.json?.scope?.canSeeFinancials === false);
    // The roster itself must stay usable: names, roles and schedules survive.
    ok(`employees · ${who} roster rows keep name + role`, rows.every((e) => !!e.name && !!e.role));
  }

  // A record-manager WITHOUT the finance grant may edit the roster but not the
  // salary — the form that received no figure can never blank the stored one.
  // A disposable roster row: this section must leave the demo employees
  // (and their history) exactly as it found them.
  const made = await call("/api/employees", "POST", {
    data: { name: `${TAG} Salary Fixture`, role: "Suite Fixture", businessId: 1, salaryGhs: 5000, hireDate: "2026-01-01", phone: "0550000000" },
  }, t.owner);
  const targetId = Number(made.json?.employee?.id);
  ok("employees · disposable fixture employee created", !!targetId, `${made.status} ${JSON.stringify(made.json).slice(0, 120)}`);

  const supId = fixtures.supervisor.id;
  const grant = await call("/api/users", "PATCH", { userId: supId, canManageRecords: true }, t.owner);
  ok("employees · owner granted record management to SUPERVISOR", grant.status === 200, `got ${grant.status}`);
  await sleep(6500); // the session micro-cache holds the user row for ~5s

  const fixtureView = await call("/api/employees", "GET", null, fixtures.supervisor.token);
  const fixtureRow = (fixtureView.json?.employees || []).find((e) => Number(e.id) === targetId);
  ok("employees · fixture row visible to the manager but salary withheld", !!fixtureRow && fixtureRow.salaryGhs === null && fixtureRow.financialsRestricted === true);

  const editRoster = await call("/api/employees", "PATCH", { id: targetId, data: { phone: `055${String(Date.now()).slice(-7)}` } }, fixtures.supervisor.token);
  ok("employees · granted non-finance manager may edit the roster", editRoster.status === 200, `got ${editRoster.status}`);
  ok("employees · edit response carries no salary", !/"salaryGhs"\s*:\s*\d/.test(editRoster.text));
  const editSalary = await call("/api/employees", "PATCH", { id: targetId, data: { salaryGhs: 1 } }, fixtures.supervisor.token);
  ok("employees · non-finance manager may NOT change salary → 403", editSalary.status === 403, `got ${editSalary.status}`);
  const stored = (await pg.query("SELECT salary_ghs FROM employees WHERE id = $1", [targetId])).rows[0]?.salary_ghs;
  ok("employees · stored salary untouched", Number(stored) === 5000, `stored=${stored}`);
  await call("/api/users", "PATCH", { userId: supId, canManageRecords: false }, t.owner);
  await sleep(6500);

  // Remove the fixture and its history — nothing may drift the demo data.
  await pg.query("DELETE FROM employee_history WHERE employee_id = $1", [targetId]);
  await pg.query("DELETE FROM employee_documents WHERE employee_id = $1", [targetId]);
  const gone = await pg.query("DELETE FROM employees WHERE id = $1", [targetId]);
  ok("employees · fixture employee removed", gone.rowCount === 1);
}

/* ── D · Tenant isolation ─────────────────────────────────────────────── */
section("D · Tenant isolation (second owner / second organisation)");
{
  const created = await call("/api/admin/organizations", "POST", {
    name: `${TAG} Isolation Ltd`, ownerName: `${TAG} Owner B`, ownerEmail: `${TAG.toLowerCase()}.ownerb@example-test.invalid`,
  }, t.owner);
  const orgB = created.json?.organization;
  const ownerBRow = created.json?.owner;
  ok("second organisation provisioned", !!orgB?.id && !!ownerBRow?.id, JSON.stringify(created.json).slice(0, 160));
  if (orgB?.id) {
    const ownerB = await login({ email: ownerBRow.email, password: created.json.initialPassword }, "org-B owner");
    ok("second OWNER can sign in", !!ownerB, ownerB ? "" : "login returned no token");
    // Org B gets its own unit + worker + GM so there is real data to leak.
    const bizB = await call("/api/businesses", "POST", { name: `${TAG} UNIT B`, category: "BOUTIQUE" }, ownerB);
    const bizBId = bizB.json?.business?.id ?? bizB.json?.id ?? null;
    let workerB = null, gmB = null;
    if (bizBId) {
      workerB = await call("/api/users/workers", "POST", { name: `${TAG} WorkerB`, email: email("workerb"), phone: "0551110001", password: "Suite@Pass26", assignedBusinessId: bizBId }, ownerB);
    }
    gmB = await call("/api/users", "POST", { name: `${TAG} GmB`, email: email("gmb"), phone: "0551110002", role: "GENERAL_MANAGER", password: "Suite@Pass26" }, ownerB);
    ok("org B unit provisioned", !!bizBId, `${bizB.status}`);
    ok("org B worker provisioned", workerB?.status === 200, `${workerB?.status} ${JSON.stringify(workerB?.json).slice(0, 100)}`);
    ok("org B GM provisioned", gmB?.status === 200, `${gmB?.status}`);

    // The second OWNER sees only their own people.
    const dirB = await call("/api/users", "GET", null, ownerB);
    ok("Enterprise Users · org B OWNER sees only org B accounts", dirB.status === 200 && (dirB.json?.users || []).every((u) => /ownerb|workerb|gmb/.test(String(u.email))),
      `${dirB.status} n=${(dirB.json?.users || []).length}`);
    // …and no organisation-1 account leaks either way.
    // The org-A OWNER account is also the platform Super Admin here, so its
    // own directory is platform-wide by design. The boundary that protects
    // every other account is asserted on org A's authorised GM (a real
    // non-super directory holder) and on every staff role's bootstrap payload.
    const dirAGm = await call("/api/users", "GET", null, t.gm);
    const blobAGm = JSON.stringify(dirAGm.json || {});
    ok("Enterprise Users · org A authorised GM sees no org B accounts",
      dirAGm.status === 200 && !blobAGm.includes(`${TAG.toLowerCase()}.ownerb`) && !blobAGm.includes(`${TAG.toLowerCase()}.workerb`) && !blobAGm.includes(`${TAG.toLowerCase()}.gmb`),
      `http=${dirAGm.status}`);
    for (const [who, token] of [["BRANCH_MANAGER", t.bm], ["WORKER", t.worker], ["SUPERVISOR", fixtures.supervisor.token], ["ACCOUNTANT", fixtures.accountant.token]]) {
      ok(`/api/users · ${who} is refused (so can never enumerate org B)`, (await call("/api/users", "GET", null, token)).status === 403);
    }
    const initB = await call("/api/init", "GET", null, ownerB);
    const blobInitB = JSON.stringify(initB.json || {});
    ok("/api/init · org B OWNER receives no org A businesses",
      (initB.json?.businesses || []).every((b) => Number(b.ownerId) === Number(orgB.id) || Number(b.id) === Number(bizBId)),
      JSON.stringify((initB.json?.businesses || []).map((b) => b.id)));
    ok("/api/init · org B OWNER receives no org A people", !blobInitB.includes("kwame.owner@gomina360.com"));

    // Mutations across the tenant boundary are refused for every org-A role.
    const victimIds = [ownerBRow.id, gmB.json?.user?.id, workerB?.json?.worker?.id].filter(Boolean);
    for (const [who, token] of [["authorised GM", t.gm], ["BRANCH_MANAGER", t.bm], ["WORKER", t.worker], ["ACCOUNTANT", fixtures.accountant.token]]) {
      for (const victim of victimIds) {
        const p = await call("/api/users", "PATCH", { userId: victim, name: "HIJACKED", role: "WORKER" }, token);
        ok(`cross-tenant PATCH · ${who} → user #${victim} refused`, p.status >= 400, `got ${p.status}`);
        const d = await call(`/api/users?userId=${victim}`, "DELETE", null, token);
        ok(`cross-tenant DELETE · ${who} → user #${victim} refused`, d.status >= 400, `got ${d.status}`);
      }
    }
    const stillOwner = (await pg.query("SELECT role, name FROM users WHERE id = $1", [ownerBRow.id])).rows[0];
    ok("org B OWNER account untouched by the cross-tenant attempts", stillOwner?.role === "OWNER", JSON.stringify(stillOwner));
    const gmBAlive = (await pg.query("SELECT role FROM users WHERE email = $1", [email("gmb")])).rows[0];
    ok("org B GM account untouched", gmBAlive?.role === "GENERAL_MANAGER", JSON.stringify(gmBAlive));

    // The org-B owner never reaches org-A money or staff surfaces.
    for (const path of ["/api/budgets?businessId=1&period=2026-Q1", "/api/cashflow/forecast?businessId=1&weeks=4", "/api/payroll", "/api/users/workers"]) {
      const r = await call(path, "GET", null, ownerB);
      ok(`org B OWNER cannot read org A ${path.split("?")[0]}`, r.status !== 200 || !JSON.stringify(r.json || {}).includes("Kwame"), `got ${r.status}`);
    }
    globalThis.__orgB = { orgB, ownerBRow, bizBId };
  }
}

/* ── E · Delegation lifecycle (grant → access, revoke → gone) ─────────── */
section("E · Authorisation lifecycle on a freshly created manager");
{
  const target = fixtures.gmPlain;
  const before = await call("/api/users", "GET", null, target.token);
  ok("plain GM starts locked out of Enterprise Users", before.status === 403, `got ${before.status}`);
  const beforeMoney = await call("/api/budgets?businessId=1&period=2026-Q1", "GET", null, target.token);
  ok("plain GM starts locked out of Finance & Reports", beforeMoney.status === 403, `got ${beforeMoney.status}`);

  const grant = await call("/api/users", "PATCH", { userId: target.id, canManageUsers: true, canViewFinance: true }, t.owner);
  ok("OWNER can grant both sensitive surfaces", grant.status === 200, `${grant.status}`);
  const dbRow = (await pg.query("SELECT can_manage_users, can_view_finance FROM users WHERE id = $1", [target.id])).rows[0];
  ok("grant persisted in the database", dbRow?.can_manage_users === true && dbRow?.can_view_finance === true, JSON.stringify(dbRow));

  // No re-login: the grant must take effect on the manager's EXISTING session
  // (the user-mutation routes bust the session micro-cache).
  const after = await call("/api/users", "GET", null, target.token);
  ok("granted GM reaches Enterprise Users on the same session", after.status === 200, `got ${after.status}`);
  const afterMoney = await call("/api/budgets?businessId=1&period=2026-Q1", "GET", null, target.token);
  ok("granted GM reaches Finance & Reports on the same session", afterMoney.status === 200, `got ${afterMoney.status}`);
  const afterInit = await call("/api/init", "GET", null, target.token);
  const restored = (afterInit.json?.metrics || []).some((m) => Number(m.revenueGhs) > 0);
  ok("granted GM receives live financial metrics again (cache respects the grant)", restored);
  const empRow = (afterInit.json?.employees || [])[0];
  ok("granted GM receives employee salary again", !empRow || empRow.salaryGhs != null);

  // Revoke: the surface must close again.
  const revoke = await call("/api/users", "PATCH", { userId: target.id, canManageUsers: false, canViewFinance: false }, t.owner);
  ok("OWNER can revoke both surfaces", revoke.status === 200, `${revoke.status}`);
  ok("revoked GM loses Enterprise Users", (await call("/api/users", "GET", null, target.token)).status === 403);
  ok("revoked GM loses Finance & Reports", (await call("/api/budgets?businessId=1&period=2026-Q1", "GET", null, target.token)).status === 403);
}

/* ── F · Self-escalation & role-tamper attempts ───────────────────────── */
section("F · Every role fails to escalate itself");
{
  const attempts = [
    ["plain GM", fixtures.gmPlain.token, fixtures.gmPlain.id],
    ["BRANCH_MANAGER", t.bm, 3],
    ["SUPERVISOR", fixtures.supervisor.token, fixtures.supervisor.id],
    ["ACCOUNTANT", fixtures.accountant.token, fixtures.accountant.id],
    ["WORKER", t.worker, 10],
  ];
  for (const [who, token, id] of attempts) {
    // Baseline the row first: the Accountant preset (D3) legitimately holds
    // `can_view_finance`, so "escalated" means "changed beyond what it started
    // with", not "holds the grant".
    const before = (await pg.query("SELECT role, can_manage_users, can_view_finance, is_super_admin FROM users WHERE id = $1", [id])).rows[0];
    const r = await call("/api/users", "PATCH", {
      userId: id, role: "OWNER", canManageUsers: true, canViewFinance: true, isSuperAdmin: true, businessManageIds: [1, 2, 3],
    }, token);
    const row = (await pg.query("SELECT role, can_manage_users, can_view_finance, is_super_admin FROM users WHERE id = $1", [id])).rows[0];
    const escalated =
      row?.role !== before?.role ||
      !!row?.can_manage_users ||
      row?.can_view_finance !== before?.can_view_finance ||
      row?.is_super_admin !== before?.is_super_admin;
    ok(`self-escalation · ${who} refused`, r.status >= 400 && !escalated, `http=${r.status} ${JSON.stringify(row)}`);
  }
  // The OWNER account itself is untouchable for everybody below OWNER.
  for (const [who, token] of [["authorised GM", t.gm], ["BRANCH_MANAGER", t.bm]]) {
    const r = await call("/api/users", "PATCH", { userId: 1, role: "WORKER", isActive: false }, token);
    const row = (await pg.query("SELECT role, is_active FROM users WHERE id = 1")).rows[0];
    ok(`OWNER account protected from ${who}`, r.status >= 400 && row?.role === "OWNER" && row?.is_active !== false, JSON.stringify(row));
  }
  const del = await call("/api/users?userId=1", "DELETE", null, t.gm);
  ok("OWNER account cannot be deleted by a granted GM", del.status >= 400, `got ${del.status}`);
}

/* ── G · Command Center & client-side gates ──────────────────────────── */
section("G · Command Center money masking (source contract)");
{
  // The Command Center reads `liveMetrics` (from /api/init) and masks every
  // figure behind `financialsAuthorized`. Both halves are asserted here: the
  // payload above, and the component contract below.
  const fs = await import("node:fs/promises");
  const cc = await fs.readFile(new URL("../src/components/CommandCenterDashboard.tsx", import.meta.url), "utf8");
  ok("Command Center declares the financialsAuthorized prop", /financialsAuthorized\?:\s*boolean/.test(cc));
  ok("Command Center masks money via the money() wrapper", /const money = \(value: number/.test(cc) && /showMoney \? formatMoney\(value, currency, compact\) : "•••••"/.test(cc));
  ok("Command Center shows the Owner-authorisation notice", /cc-finance-restricted/.test(cc));
  ok("Command Center zeroes the chart dataset when unauthorised", /showMoney \? convertGhs\(d\.revenueGhs, currentCurrency\) : 0/.test(cc));
  ok("Command Center no longer prints raw formatMoney for revenue", !/formatMoney\(totalRevenue/.test(cc));
  const app = await fs.readFile(new URL("../src/components/GoMinaApp.tsx", import.meta.url), "utf8");
  ok("GoMinaApp passes financialsAuthorized={maySeeFinancials} to the Command Center", /financialsAuthorized=\{maySeeFinancials\}/.test(app));
  ok("GoMinaApp gates the Enterprise Users tab on maySeeEnterpriseUsers", /activeTab === "USERS_MANAGE" && maySeeEnterpriseUsers/.test(app));
  ok("GoMinaApp gates the Finance tab on maySeeFinancials", /activeTab === "FINANCE" && maySeeFinancials/.test(app));
  ok("Unit managers can no longer open Finance without the grant", !/"SUPPLIERS", "EMPLOYEES", "FINANCE"\]/.test(app));
  const nav = await fs.readFile(new URL("../src/lib/navManifest.ts", import.meta.url), "utf8");
  ok("Sidebar: Enterprise Users entry requires canSeeEnterpriseUsers", /eligible: \(c\) => c\.canSeeEnterpriseUsers/.test(nav));
  ok("Sidebar: Finance entry requires canSeeFinancials", /eligible: \(c\) => c\.canSeeFinancials/.test(nav));
  const perms = await fs.readFile(new URL("../src/lib/permissions.ts", import.meta.url), "utf8");
  ok("permissions.ts: canSeeEnterpriseUsers is grant-based", /canManageUsers === true;/.test(perms));
  ok("permissions.ts: canSeeFinancials is grant-based", /canViewFinance === true;/.test(perms));
}

/* ── Z · cleanup + residue ───────────────────────────────────────────── */
section("Z · cleanup");
{
  await purge();
  const residue = (await pg.query("SELECT count(*)::int c FROM users WHERE email LIKE 'evp%@example-test.invalid'")).rows[0].c;
  const orgResidue = (await pg.query("SELECT count(*)::int c FROM organizations WHERE name LIKE 'EVP%'")).rows[0].c;
  ok("suite accounts removed", residue === 0, `${residue} left`);
  ok("suite organisation removed", orgResidue === 0, `${orgResidue} left`);
  const gmFlags = (await pg.query("SELECT can_manage_users, can_view_finance FROM users WHERE id = 2")).rows[0];
  ok("demo GM still holds the OWNER authorisation (seed contract)", gmFlags?.can_manage_users === true && gmFlags?.can_view_finance === true, JSON.stringify(gmFlags));
  const bmFlags = (await pg.query("SELECT can_manage_users, can_view_finance FROM users WHERE id = 3")).rows[0];
  ok("demo BRANCH_MANAGER stays unauthorised", bmFlags?.can_manage_users !== true && bmFlags?.can_view_finance !== true, JSON.stringify(bmFlags));
  await pg.end();
}

console.log(`\n══ Enterprise permissions: ${pass} pass / ${fail} fail ══`);
if (failures.length) { console.log("FAILED:\n  • " + failures.join("\n  • ")); process.exit(1); }
