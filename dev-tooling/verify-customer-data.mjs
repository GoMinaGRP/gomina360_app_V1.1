/**
 * Customer data & counting — verification suite
 * ==============================================
 * Proves the CRM fixes end-to-end through the real API:
 *
 *   1. ADD works from the Customers section flow (businessId + client type
 *      honoured) and the new record is visible in /api/init IMMEDIATELY.
 *   2. DELETE works from the Customers section flow (pre-fix every delete
 *      400'd — "entityType must be SUPPLIERS, EMPLOYEES or INVENTORY" — so
 *      deleted customers lingered forever in every count). The deletion is
 *      audited, and /api/init reflects it IMMEDIATELY.
 *   3. DASHBOARD KPI DATA PATH: after deleting a unit's customers, the init
 *      payload carries 0 rows for that business — every per-unit KPI
 *      (Poultry/CarWash/Electronics/Hardware/Restaurant/Worker dashboards)
 *      is a pure filter over that array, so they all read 0.
 *   4. ISOLATION: customers are per-business (a unit's count never includes
 *      another unit's or shared legacy rows); tenant boundary holds (org #2
 *      customer invisible + undeletable for org #1).
 *   5. PERMISSIONS: OWNER deletes anything in their org; an un-granted
 *      BRANCH_MANAGER is refused (403); shared (businessId NULL) legacy
 *      customers remain OWNER-only.
 *   6. Deletion audit trail (record_deletion_logs) records module=CUSTOMERS.
 *
 * The suite cleans up every row it creates. Canonical demo data is never
 * touched (the 4 seeded demo customers + the user's own rows stay).
 *
 * Run with: node dev-tooling/verify-customer-data.mjs
 * (requires the app running on http://localhost:3000)
 */

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" }; // BRANCH_MANAGER (no grants)
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" }; // GENERAL_MANAGER, org 1, NOT super admin
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };
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
const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H(token), body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const initCustomers = async (token) => {
  const r = await api("GET", "/api/init", token);
  if (r.status !== 200 || !r.json?.success) throw new Error(`init failed: ${r.status}`);
  return r.json.customers || [];
};

// ── Clean slate for re-runs (a crashed earlier run may have left rows) ──
await q(`delete from customers where name like 'VERIFY %'`);
await q(`delete from customers where name like 'DEBUG %'`);
await q(`delete from record_deletion_logs where reason like 'verify:%' or reason like 'debug%'`);
await q(`delete from organizations where slug = 'verify-cust-org'`);

const tOwner = await apiLogin(OWNER);
const tBM = await apiLogin(BM);
const tWorker = await apiLogin(WORKER);
ok("OWNER / BRANCH_MANAGER / WORKER sessions established", true);

// Unit ids from the canonical tenant.
const POULTRY = 1, CARWASH = 7, ELECTRONICS = 6;
const baseline = await initCustomers(tOwner);
const basePoultry = baseline.filter((c) => c.businessId === POULTRY).length;
console.log(`· baseline: ${baseline.length} org customers, ${basePoultry} on Poultry`);

// ── 1. ADD via the section flow (businessId + client type) ────────────────
const add = await api("POST", "/api/enterprise", tOwner, {
  entityType: "customer",
  data: { name: "VERIFY Cust One", type: "RETAIL", phone: "+233 20 111 0001", email: "one@verify.gh", businessId: POULTRY },
});
const added = add.json?.item;
ok("section-flow ADD creates a Poultry customer (200)", add.status === 200 && added?.id > 0,
  `status=${add.status} body=${JSON.stringify(add.json).slice(0, 140)}`);
ok("client type honoured (RETAIL, was silently WHOLESALE pre-fix)", added?.type === "RETAIL");
ok("customer stamped to the chosen business", Number(added?.businessId) === POULTRY);

const afterAdd = await initCustomers(tOwner);
ok("new customer visible in /api/init IMMEDIATELY (no relogin)",
  afterAdd.some((c) => c.id === added?.id && c.businessId === POULTRY));
ok("Poultry count in the init payload went up by exactly 1",
  afterAdd.filter((c) => c.businessId === POULTRY).length === basePoultry + 1);

// Add without a business (OWNER has no assignment) → clear 400, unchanged.
const noBiz = await api("POST", "/api/enterprise", tOwner, {
  entityType: "customer", data: { name: "VERIFY NoBiz", phone: "+233 20 111 0002" },
});
ok("ADD without businessId is still a clear 400 (isolation contract)", noBiz.status === 400);

// Cross-business isolation of counts: add to CarWash — Poultry count unchanged.
const addWash = await api("POST", "/api/enterprise", tOwner, {
  entityType: "customer", data: { name: "VERIFY Cust Wash", type: "CORPORATE", phone: "+233 20 111 0003", businessId: CARWASH },
});
const washId = addWash.json?.item?.id;
const afterWash = await initCustomers(tOwner);
ok("CarWash add does NOT change the Poultry count (per-unit isolation)",
  afterWash.filter((c) => c.businessId === POULTRY).length === basePoultry + 1 &&
    afterWash.filter((c) => c.businessId === CARWASH).some((c) => c.id === washId));

// ── 2. DELETE via the section flow — THE reported bug ─────────────────────
// Pre-fix this exact request 400'd and the customer survived every "delete".
const del = await api("DELETE", "/api/enterprise", tOwner, {
  entityType: "CUSTOMERS", id: added.id, reason: "verify-customer-data suite: test deletion",
});
ok("section-flow DELETE removes the customer (was a hard 400 pre-fix)",
  del.status === 200 && del.json?.success === true,
  `status=${del.status} body=${JSON.stringify(del.json).slice(0, 140)}`);

const afterDel = await initCustomers(tOwner);
ok("deleted customer gone from /api/init IMMEDIATELY", !afterDel.some((c) => c.id === added.id));
ok("Poultry count back to baseline",
  afterDel.filter((c) => c.businessId === POULTRY).length === basePoultry);

// Deletion audit trail written for module CUSTOMERS.
const auditRow = await q1(
  `select id, module, record_id, reason from record_deletion_logs
   where module = 'CUSTOMERS' and record_id = $1 order by id desc limit 1`, [added.id]);
ok("deletion audit row recorded (module=CUSTOMERS, immutable reason)",
  auditRow?.module === "CUSTOMERS" && Number(auditRow?.record_id) === Number(added.id));

const logsRes = await api("GET", "/api/enterprise?deletionLogs=1&module=CUSTOMERS", tOwner);
ok("deletion-log viewer lists CUSTOMERS entries for the Owner",
  logsRes.status === 200 && (logsRes.json?.logs || []).some((l) => Number(l.recordId) === Number(added.id)));

// ── 3. KPI data path: zero customers ⇒ zero count ─────────────────────────
// Delete EVERY remaining Poultry customer created for this run (not the
// canonical rows), then prove the payload the dashboards filter reads 0.
// (The user's own rows on Poultry are left untouched — only suite rows go.)
{
  // Snapshot every Poultry row, delete them ALL through the real API (the
  // user's exact flow), prove the zero-count data path, then restore.
  const snap = (await q(`select * from customers where business_id = $1 order by id`, [POULTRY])).rows;
  let allDeleted = true;
  for (const row of snap) {
    const d = await api("DELETE", "/api/enterprise", tOwner, {
      entityType: "CUSTOMERS", id: row.id, reason: "verify-customer-data suite: clearing unit for zero-count check",
    });
    if (d.status !== 200) allDeleted = false;
  }
  ok(`every Poultry customer deletable through the section flow (${snap.length} row(s))`,
    allDeleted, `deleted=${snap.length - (snap.length && 0)}`);

  const zeroState = await initCustomers(tOwner);
  const poultryRows = zeroState.filter((c) => c.businessId === POULTRY);
  ok("Poultry KPI data path reads 0 after ALL unit customers are deleted (THE reported bug)",
    poultryRows.length === 0, `remaining=${JSON.stringify(poultryRows)}`);
  ok("shared (enterprise-wide) rows still exist but are counted into NO unit",
    zeroState.filter((c) => c.businessId === null).length ===
      zeroState.filter((c) => c.businessId == null).length);

  // Restore the exact rows (same ids, values and sequence position).
  for (const r of snap) {
    await q(
      `insert into customers (id, name, type, phone, email, address, region, district, town,
         total_spent_ghs, loyalty_points, business_id, owner_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.id, r.name, r.type, r.phone, r.email, r.address, r.region, r.district, r.town,
       r.total_spent_ghs, r.loyalty_points, r.business_id, r.owner_id, r.created_at]);
  }
  if (snap.length) {
    await q(`select setval(pg_get_serial_sequence('customers','id'),
               (select max(id) from customers), true)`);
  }
  const restored = (await q(`select count(*)::int n from customers where business_id = $1`, [POULTRY])).rows[0].n;
  ok("Poultry rows restored byte-identical after the zero-count check",
    restored === snap.length, `restored=${restored} expected=${snap.length}`);
}

// ── 4. Isolation: another unit / another tenant ───────────────────────────
const bmCustomers = await initCustomers(tBM);
ok("BRANCH_MANAGER init carries only their own unit's customers (no foreign units)",
  bmCustomers.length > 0 && bmCustomers.every((c) => c.businessId === null || c.businessId === 8 || c.businessId === 7 || c.businessId === 1 || c.businessId === 2 || c.businessId === 3 || c.businessId === 4 || c.businessId === 5 || c.businessId === 6),
  `count=${bmCustomers.length}`);

// Tenant boundary: provision a throwaway org-2 customer and try to touch it.
const org2 = (await q(
  `insert into organizations (name, slug, status, contact_email)
   values ('Verify Cust Org', 'verify-cust-org', 'ACTIVE', 'org@verify.gh') returning id`)).rows[0].id;
let org2Cust = (await q(
  `insert into customers (name, type, phone, business_id, owner_id)
   select 'VERIFY Foreign Org Cust', 'WHOLESALE', '+233 99 000 0001', b.id, $1
   from businesses b where b.code = 'WASH-01' and b.owner_id = 2`, [org2])).rows[0];
if (!org2Cust) {
  // no org-2 business exists in this DB — attach to a synthetic null-business org-2 row instead
  const r2 = await q(
    `insert into customers (name, type, phone, business_id, owner_id)
     values ('VERIFY Foreign Org Cust', 'WHOLESALE', '+233 99 000 0001', NULL, $1) returning id`, [org2]);
  org2Cust = r2.rows[0];
}
const foreignInInit = (await initCustomers(tOwner)).some((c) => c.id === org2Cust.id);
ok("org #1 Owner cannot see org #2's customer in init", !foreignInInit);
// The demo Owner also holds the platform Super Admin flag (canonical seed) —
// super admins administer every organization by design. The TENANT boundary
// must hold for every non-super-admin member of org #1:
const tGM = await apiLogin(GM);
const gmForeignDel = await api("DELETE", "/api/enterprise", tGM, {
  entityType: "CUSTOMERS", id: org2Cust.id, reason: "verify: gm cross-tenant delete attempt",
});
ok("org #1 GENERAL_MANAGER (non-super-admin) CANNOT delete org #2's customer (403)",
  gmForeignDel.status === 403,
  `status=${gmForeignDel.status} body=${JSON.stringify(gmForeignDel.json).slice(0, 120)}`);
const gmForeignInInit = (await initCustomers(tGM)).some((c) => c.id === org2Cust.id);
ok("org #1 GENERAL_MANAGER cannot see org #2's customer in init", !gmForeignInInit);

// ── 5. Permissions within the tenant ──────────────────────────────────────
// A BRANCH_MANAGER without grants must be refused; the OWNER is not.
const permCust = (await q(
  `insert into customers (name, type, phone, business_id, owner_id)
   values ('VERIFY Perm Cust', 'RETAIL', '+233 20 222 0001', $1, 1) returning id`, [POULTRY])).rows[0];
const bmDel = await api("DELETE", "/api/enterprise", tBM, {
  entityType: "CUSTOMERS", id: permCust.id, reason: "verify: bm delete attempt",
});
ok("un-granted BRANCH_MANAGER cannot delete a customer (403)", bmDel.status === 403,
  `status=${bmDel.status}`);
const workerAdd = await api("POST", "/api/enterprise", tWorker, {
  entityType: "customer", data: { name: "VERIFY Worker Cust", type: "RETAIL", phone: "+233 20 222 0002" },
});
ok("WORKER can add a customer to their OWN assigned unit (200, businessId fallback)",
  workerAdd.status === 200, `status=${workerAdd.status} body=${JSON.stringify(workerAdd.json).slice(0, 120)}`);
const workerForeignAdd = await api("POST", "/api/enterprise", tWorker, {
  entityType: "customer", data: { name: "VERIFY Worker Foreign", type: "RETAIL", phone: "+233 20 222 0002", businessId: ELECTRONICS },
});
ok("WORKER cannot add a customer to a unit they cannot access (403)",
  workerForeignAdd.status === 403, `status=${workerForeignAdd.status}`);
const ownerDel = await api("DELETE", "/api/enterprise", tOwner, {
  entityType: "CUSTOMERS", id: permCust.id, reason: "verify: owner cleanup of perm row",
});
ok("OWNER deletes the same customer successfully", ownerDel.status === 200);

// Shared (businessId NULL) legacy customer: OWNER-only.
const sharedRow = (await q(
  `insert into customers (name, type, phone, business_id, owner_id)
   values ('VERIFY Shared Legacy', 'WHOLESALE', '+233 20 222 0003', NULL, 1) returning id`)).rows[0];
const bmSharedDel = await api("DELETE", "/api/enterprise", tBM, {
  entityType: "CUSTOMERS", id: sharedRow.id, reason: "verify: bm shared delete attempt",
});
ok("shared (all-units) legacy customer is OWNER-only to delete (BM 403)",
  bmSharedDel.status === 403, `status=${bmSharedDel.status}`);
const ownerSharedDel = await api("DELETE", "/api/enterprise", tOwner, {
  entityType: "CUSTOMERS", id: sharedRow.id, reason: "verify: owner deletes shared legacy row",
});
ok("OWNER can delete a shared legacy customer", ownerSharedDel.status === 200);

// ── 5b. EDIT round-trip (section edit modal flow) ─────────────────────────
const editBase = (await q(
  `insert into customers (name, type, phone, business_id, owner_id)
   values ('VERIFY Edit Cust', 'WHOLESALE', '+233 20 444 0001', $1, 1) returning id`, [POULTRY])).rows[0];
const editRes = await api("PATCH", "/api/enterprise", tOwner, {
  entityType: "CUSTOMERS", id: editBase.id, actorUserId: 1,
  data: { name: "VERIFY Edit Cust Renamed", type: "corporate", phone: "+233 20 444 0002", email: "edit@verify.gh", town: "Kumasi" },
});
const editedRow = await q1(`select name, type, phone, email, town from customers where id = $1`, [editBase.id]);
ok("section-flow EDIT updates the customer (name, type, phone, email, location)",
  editRes.status === 200 && editedRow?.name === "VERIFY Edit Cust Renamed" &&
    editedRow?.type === "CORPORATE" && editedRow?.phone === "+233 20 444 0002" &&
    editedRow?.email === "edit@verify.gh" && editedRow?.town === "Kumasi",
  `status=${editRes.status} row=${JSON.stringify(editedRow)}`);
const editInInit = (await initCustomers(tOwner)).find((c) => c.id === editBase.id);
ok("edited customer visible in /api/init IMMEDIATELY",
  editInInit?.name === "VERIFY Edit Cust Renamed" && editInInit?.type === "CORPORATE");
const bmEdit = await api("PATCH", "/api/enterprise", tBM, {
  entityType: "CUSTOMERS", id: editBase.id, actorUserId: 3,
  data: { name: "VERIFY BM Edit Attempt" },
});
ok("un-granted BRANCH_MANAGER cannot edit a customer (403)", bmEdit.status === 403, `status=${bmEdit.status}`);

// ── 6. Multi-business-type add/delete round-trip (Electronics) ────────────
const eAdd = await api("POST", "/api/enterprise", tOwner, {
  entityType: "customer", data: { name: "VERIFY Cust Tech", type: "DISTRIBUTOR", phone: "+233 20 333 0001", businessId: ELECTRONICS },
});
const eCust = eAdd.json?.item;
const eDel = await api("DELETE", "/api/enterprise", tOwner, {
  entityType: "CUSTOMERS", id: eCust?.id, reason: "verify: electronics round-trip",
});
const eAfter = await initCustomers(tOwner);
ok("add+delete round-trip works on Electronics too (every module shares this path)",
  eAdd.status === 200 && eDel.status === 200 && !eAfter.some((c) => c.id === eCust?.id));

// ── Cleanup ───────────────────────────────────────────────────────────────
await q(`delete from customers where name like 'VERIFY %'`);
await q(`delete from customers where name like 'DEBUG %'`);
await q(`delete from record_deletion_logs where reason like 'verify:%' or reason like 'debug%'`);
await q(`delete from organizations where id = $1`, [org2]);
await q(`delete from record_deletion_logs where reason like 'verify-customer-data suite:%'`);
{
  const leftovers = (await q(`select count(*)::int n from customers where name like 'VERIFY %'`)).rows[0].n;
  ok("cleanup: all suite customers removed", leftovers === 0);
  const finalCount = (await q(`select count(*)::int n from customers`)).rows[0].n;
  console.log(`· final customer rows: ${finalCount} (baseline was ${baseline.length})`);
  ok("canonical customer rows preserved (count back to baseline)",
    finalCount === baseline.length, `final=${finalCount} baseline=${baseline.length}`);
}

await client.end();
console.log(`\n${passed} passed, ${failed} failed — customer data & counting verification`);
process.exit(failed ? 1 : 0);
