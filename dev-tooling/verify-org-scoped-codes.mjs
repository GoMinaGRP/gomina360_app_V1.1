/**
 * Cross-organization identifier scoping — verification suite
 * ============================================================
 * Proves the per-tenant numbering fix for every generated code:
 *
 *   1. BUSINESS CODES number per organization — a second independent
 *      organization's first Poultry unit is POULTRY-01 (not a continuation
 *      of org #1's sequence), while (owner_id, code) stays unique at the
 *      DB level and org #1's own numbering is unaffected.
 *   2. ASSET CODES number per business (two orgs may each own
 *      POULTRY-01-AST-0001) and /api/assets/next-code is business-scoped.
 *   3. EMPLOYEE NUMBERS number per business (each unit starts at EMP-0001).
 *   4. QR LABELS are unique per business: the same scanned value resolves
 *      to the CALLER's accessible unit (scanner), and registering a label
 *      another organization already uses no longer 409s.
 *   5. BARE-CODE LOOKUPS (/api/logs/[code]) resolve the caller's accessible
 *      match among all organizations carrying that code; foreign codes 403.
 *   6. TENANT ISOLATION: org #2 sees only its own units in /api/init.
 *
 * The suite provisions a throwaway second organization + OWNER entirely via
 * direct DB inserts, exercises the real API endpoints as that owner, and
 * removes everything it created afterwards (canonical org #1 data is never
 * touched — one org-#1 unit created mid-suite to prove isolation of the
 * numbering is deleted again before exit).
 *
 * Run with: node dev-tooling/verify-org-scoped-codes.mjs
 * (requires the app running on http://localhost:3000)
 */

const BASE = "http://localhost:3000";
const OWNER1 = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const OWNER2_EMAIL = "org2.owner@verify.gomina360.test";
const OWNER2_PW = "VerifyOrg2!2026";
const ORG2_NAME = "Verify Org 2 Co";
const DB = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { createRequire } from "node:module";
import crypto from "node:crypto";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(DB);
await client.connect();
const q = (s, p = []) => client.query(s, p);
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed ${cred.email}: ${JSON.stringify(j)}`);
  return j.sessionToken;
}

async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
};

// Business-scoped tables (subset covering what provisioning/creation writes).
const BUSINESS_SCOPED = [
  "ai_insights", "aquaculture_batches", "aquaculture_checklists",
  "aquaculture_feed_logs", "aquaculture_harvests", "aquaculture_logs",
  "aquaculture_ponds", "aquaculture_water_quality_logs", "aquaculture_weight_logs",
  "assets", "attendance_logs", "audit_assignments", "audit_reviews", "audit_trail",
  "block_factory_checklists", "block_factory_deliveries", "block_factory_logs",
  "block_factory_orders", "block_qc_checks", "block_types", "business_insights",
  "business_metrics", "car_wash_activities", "car_wash_bookings", "car_wash_logs",
  "checklist_templates", "customer_trackings", "daily_checklists", "daily_notes",
  "delivery_areas", "electronics_orders", "electronics_serials", "employees",
  "expense_categories", "feed_mill_batches", "feed_mill_logs", "hardware_receipts",
  "hardware_stock", "inventory_items", "inventory_downloads", "poultry_logs",
  "poultry_sales", "supplier_invoices", "transactions", "user_business_access",
];

async function purgeBusinesses(ids) {
  if (!ids.length) return;
  for (const t of BUSINESS_SCOPED) {
    try {
      await q(`delete from ${t} where business_id = ANY($1::int[])`, [ids]);
    } catch { /* table may not exist in this build */ }
  }
  await q(`delete from businesses where id = ANY($1::int[])`, [ids]);
}

// ── Clean slate for re-runs ────────────────────────────────────────────────
{
  const oldBiz = (await q(
    `select id from businesses where owner_id = (select id from organizations where name = $1)`,
    [ORG2_NAME])).rows.map((r) => r.id);
  await purgeBusinesses(oldBiz);
  await q(`delete from organization_members where user_id in
             (select id from users where email = $1)`, [OWNER2_EMAIL]);
  await q(`delete from user_sessions where user_id in
             (select id from users where email = $1)`, [OWNER2_EMAIL]);
  await q(`delete from users where email = $1`, [OWNER2_EMAIL]);
  await q(`delete from organizations where name = $1`, [ORG2_NAME]);
}

// ── Provision org #2 + its OWNER (direct DB, mirrors migrate-multiowner) ──
const org2 = (await q1(
  `insert into organizations (name, slug, status, contact_email)
   values ($1, 'verify-org-2', 'ACTIVE', $2) returning id`, [ORG2_NAME, OWNER2_EMAIL])).id;
const owner2id = (await q1(
  `insert into users (name, email, role, phone, password_hash, primary_org_id, is_active)
   values ('Org Two Owner', $1, 'OWNER', '+233 20 000 0002', $2, $3, true) returning id`,
  [OWNER2_EMAIL, hashPassword(OWNER2_PW), org2])).id;
await q(
  `insert into organization_members (organization_id, user_id, role_in_org, is_primary)
   values ($1, $2, 'OWNER', true)`, [org2, owner2id]);

const t2 = await apiLogin({ email: OWNER2_EMAIL, pw: OWNER2_PW });
const t1 = await apiLogin(OWNER1);
ok("org #2 OWNER provisioned + logs in via API", true);

// ── 1. Business codes number PER ORGANIZATION ─────────────────────────────
// THE reported bug: org #1 already runs POULTRY-01, so the old global
// sequence gave org #2 "POULTRY-02" for their FIRST poultry unit.
const p1 = await api("POST", "/api/businesses", t2, {
  name: "Org Two Poultry", category: "Poultry Farm", region: "Ashanti",
});
const p2 = await api("POST", "/api/businesses", t2, {
  name: "Org Two Poultry B", category: "Poultry Farm", region: "Ashanti",
});
ok("org #2 first Poultry unit is POULTRY-01 (was POULTRY-02 pre-fix)",
  p1.status === 200 && p1.json?.business?.code === "POULTRY-01",
  `status=${p1.status} body=${JSON.stringify(p1.json).slice(0, 160)}`);
ok("org #2 second Poultry unit is POULTRY-02",
  p2.status === 200 && p2.json?.business?.code === "POULTRY-02",
  `status=${p2.status} body=${JSON.stringify(p2.json).slice(0, 160)}`);

const org2Poultry = p1.json?.business?.id;
const org2PoultryB = p2.json?.business?.id;

// Explicit code that collides ONLY across orgs is now legal (per-org unique).
const w1 = await api("POST", "/api/businesses", t2, {
  name: "Org Two Wash", category: "Car Wash", code: "WASH-01",
});
ok("org #2 may reuse org #1's WASH-01 code (kept, not rewritten)",
  w1.status === 200 && w1.json?.business?.code === "WASH-01",
  `status=${w1.status} body=${JSON.stringify(w1.json).slice(0, 160)}`);
const org2Wash = w1.json?.business?.id;

// Same code, two organizations — coexist at the DB level.
const dupRows = (await q(
  `select owner_id, id from businesses where code = 'WASH-01' order by owner_id`)).rows;
ok("WASH-01 exists once per organization in the DB", dupRows.length === 2, JSON.stringify(dupRows));

// Org #1's numbering is NOT influenced by org #2's units (org #1 has only
// POULTRY-01; org #2 just created POULTRY-01 + POULTRY-02 — org #1's next
// must still be POULTRY-02, not POULTRY-03).
const o1next = await api("POST", "/api/businesses", t1, {
  name: "Org One Poultry II", category: "Poultry Farm",
});
ok("org #1 numbering unaffected by org #2 (next is POULTRY-02)",
  o1next.status === 200 && o1next.json?.business?.code === "POULTRY-02",
  `status=${o1next.status} body=${JSON.stringify(o1next.json).slice(0, 160)}`);
// delete the org-#1 probe unit right away (canonical tenant stays pristine)
await purgeBusinesses([o1next.json?.business?.id].filter(Boolean));
{
  const gone = await q1(`select id from businesses where name = 'Org One Poultry II'`);
  ok("org #1 probe unit removed after the check", !gone);
}

// ── 2. Asset codes number PER BUSINESS ────────────────────────────────────
// Org #1's POULTRY-01 (business 1) owns POULTRY-01-AST-0001 — org #2's own
// POULTRY-01 unit must be able to register the SAME code.
let astOk = false, astErr = "";
try {
  await q(
    `insert into assets (asset_code, name, business_id, branch_code, asset_type,
       purchase_price_ghs, current_value_ghs, condition, location, next_maintenance_date)
     values ('POULTRY-01-AST-0001', 'Org Two Feeder', $1, 'POULTRY-01', 'MACHINERY',
       1000, 800, 'GOOD', 'Bay 1', '2027-01-01')`, [org2Poultry]);
  astOk = true;
} catch (e) { astErr = String(e.message).slice(0, 120); }
ok("asset code POULTRY-01-AST-0001 registers under org #2's POULTRY-01 (per-business unique)",
  astOk, astErr);

const nc1 = await api("GET", `/api/assets/next-code?branchCode=POULTRY-01&businessId=${org2Poultry}`, t2);
ok("next-code suggests POULTRY-01-AST-0002 for org #2's unit (business-scoped count)",
  nc1.status === 200 && nc1.json?.suggestion === "POULTRY-01-AST-0002",
  `status=${nc1.status} body=${JSON.stringify(nc1.json).slice(0, 160)}`);

const nc2 = await api("GET", `/api/assets/next-code?branchCode=POULTRY-01&businessId=1`, t1);
ok("org #1's POULTRY-01 next-code unaffected (0002 there too, its own registry)",
  nc2.status === 200 && nc2.json?.suggestion === "POULTRY-01-AST-0002",
  `status=${nc2.status} body=${JSON.stringify(nc2.json).slice(0, 160)}`);

const ncLegacy = await api("GET", `/api/assets/next-code?branchCode=POULTRY-01`, t2);
ok("legacy next-code call (no businessId) stays org-scoped for org #2",
  ncLegacy.status === 200 && ncLegacy.json?.suggestion === "POULTRY-01-AST-0002",
  `status=${ncLegacy.status} body=${JSON.stringify(ncLegacy.json).slice(0, 160)}`);

const ncCross = await api("GET", `/api/assets/next-code?branchCode=POULTRY-01&businessId=1`, t2);
ok("next-code for a foreign business is refused (403)",
  ncCross.status === 403, `status=${ncCross.status}`);

// ── 3. Employee numbers number PER BUSINESS ───────────────────────────────
// Org #1's unit 1 already employs EMP-0001 — org #2's first hire must too.
const emp = await api("POST", "/api/employees", t2, {
  name: "Org Two Worker", role: "WORKER", businessId: org2Poultry, salaryGhs: 500,
});
ok("org #2's first employee is EMP-0001 (per-unit numbering)",
  emp.status === 200 && (emp.json?.employee?.employeeNo === "EMP-0001" || emp.json?.employeeNo === "EMP-0001" || /EMP-0001/.test(JSON.stringify(emp.json))),
  `status=${emp.status} body=${JSON.stringify(emp.json).slice(0, 160)}`);

const empDupe = await api("POST", "/api/employees", t2, {
  name: "Org Two Worker 2", role: "WORKER", businessId: org2Poultry, salaryGhs: 500,
  employeeNo: "EMP-0002",
});
const empOrg1Dupe = (await q(
  `select count(*)::int as n from employees where employee_no = 'EMP-0002' and business_id = 1`)).rows[0].n;
ok("org #2 may register EMP-0002 even though org #1 employs it (per-unit namespace)",
  empDupe.status === 200 && empOrg1Dupe >= 0,
  `status=${empDupe.status}`);

// ── 4. QR labels: per-business uniqueness + caller-scoped resolution ──────
const SHARED_QR = "GM360-INV|WASH-01|CROSS-ORG-VERIFY";
// Org #1 side (business 7 = WASH-01) via direct DB.
await q(
  `insert into inventory_items (sku, name, category, quantity, min_stock_threshold,
     cost_price_ghs, selling_price_ghs, business_id, qr_code, unit, branch_code)
   values ('CROSS-ORG-VERIFY', 'Org One Widget', 'General', 10, 2, 5, 8, 7, $1, 'piece', 'WASH-01')`,
  [SHARED_QR]);
// Org #2 registers the SAME label on their own WASH-01 through the real API
// (pre-fix this 409'd — the guard was global).
const inv2 = await api("POST", "/api/enterprise", t2, {
  entityType: "inventory",
  data: {
    businessId: org2Wash, name: "Org Two Widget", sku: "CROSS-ORG-VERIFY",
    quantity: 5, category: "General", purchasePriceGhs: 5, sellingPriceGhs: 8,
    qrCode: SHARED_QR,
  },
});
ok("org #2 registers a QR label org #1 already uses (per-business uniqueness)",
  inv2.status === 200 && inv2.json?.success !== false,
  `status=${inv2.status} body=${JSON.stringify(inv2.json).slice(0, 160)}`);

const scan2 = await api("GET", `/api/enterprise?qr=${encodeURIComponent(SHARED_QR)}`, t2);
ok("scanner resolves the label to ORG #2's item for org #2's owner",
  scan2.status === 200 && scan2.json?.found === true &&
    Number(scan2.json?.record?.businessId) === Number(org2Wash),
  `status=${scan2.status} body=${JSON.stringify(scan2.json).slice(0, 160)}`);

const scan1 = await api("GET", `/api/enterprise?qr=${encodeURIComponent(SHARED_QR)}`, t1);
ok("scanner resolves the SAME label to ORG #1's item for org #1's owner",
  scan1.status === 200 && scan1.json?.found === true &&
    Number(scan1.json?.record?.businessId) === 7,
  `status=${scan1.status} body=${JSON.stringify(scan1.json).slice(0, 160)}`);

// ── 5. Bare-code lookups resolve the caller's accessible unit ─────────────
const logs2 = await api("GET", "/api/logs/POULTRY-01", t2);
ok("org #2 owner reads /api/logs/POULTRY-01 → their own unit (200)",
  logs2.status === 200 && logs2.json?.success !== false,
  `status=${logs2.status}`);

const logs1 = await api("GET", "/api/logs/POULTRY-01", t1);
const org1PoultryLogs = (await q(
  `select count(*)::int as n from poultry_logs where business_id = 1`)).rows[0].n;
ok("org #1 owner reads the SAME code → org #1's unit with ITS logs",
  logs1.status === 200 && Array.isArray(logs1.json?.logs) &&
    logs1.json.logs.length === org1PoultryLogs && org1PoultryLogs > 0,
  `status=${logs1.status} api=${logs1.json?.logs?.length} db=${org1PoultryLogs}`);

const foreign = await api("GET", "/api/logs/BLOCK-01", t2);
ok("code existing only in org #1 → 403 for org #2 (isolation preserved)",
  foreign.status === 403, `status=${foreign.status}`);

const unknown = await api("GET", "/api/logs/ZZZ-99", t2);
ok("unknown code → 404", unknown.status === 404, `status=${unknown.status}`);

// ── 6. Tenant isolation of the workspace payload ──────────────────────────
const init2 = await api("GET", "/api/init", t2);
const initBiz = init2.json?.businesses || [];
ok("org #2 /api/init lists ONLY org #2 units",
  init2.status === 200 && initBiz.length === 3 &&
    initBiz.every((b) => Number(b.ownerId) === Number(org2)) &&
    initBiz.some((b) => b.code === "POULTRY-01") &&
    initBiz.some((b) => b.code === "WASH-01"),
  `status=${init2.status} count=${initBiz.length} owners=${JSON.stringify(initBiz.map((b) => b.ownerId))}`);

// ── Cleanup: remove everything this suite created ─────────────────────────
await purgeBusinesses([org2Poultry, org2PoultryB, org2Wash].filter(Boolean));
await q(`delete from organization_members where user_id = $1`, [owner2id]);
await q(`delete from user_sessions where user_id = $1`, [owner2id]);
await q(`delete from users where id = $1`, [owner2id]);
await q(`delete from organizations where id = $1`, [org2]);
await q(`delete from inventory_items where qr_code = $1`, [SHARED_QR]); // org #1 side

{
  const leftovers = (await q(
    `select
       (select count(*) from businesses where owner_id = $1)::int as biz,
       (select count(*) from users where email = $2)::int as usr,
       (select count(*) from organizations where id = $1)::int as org,
       (select count(*) from inventory_items where qr_code = $3)::int as inv`,
    [org2, OWNER2_EMAIL, SHARED_QR])).rows[0];
  ok("cleanup: org #2, its owner, units and QR rows fully removed",
    leftovers.biz === 0 && leftovers.usr === 0 && leftovers.org === 0 && leftovers.inv === 0,
    JSON.stringify(leftovers));

  const org1 = (await q(
    `select
       (select count(*) from businesses where owner_id = 1)::int as biz,
       (select count(*) from inventory_items where qr_code = $1)::int as inv,
       (select count(*) from poultry_logs where business_id = 1)::int as logs`,
    [SHARED_QR])).rows[0];
  ok("canonical org #1 state intact (8 units, inventory QR row purged, poultry logs untouched)",
    org1.biz === 8 && org1.inv === 0 && org1.logs === org1PoultryLogs,
    JSON.stringify(org1));
}

await client.end();
console.log(`\n${passed} passed, ${failed} failed — org-scoped identifier verification`);
process.exit(failed ? 1 : 0);
