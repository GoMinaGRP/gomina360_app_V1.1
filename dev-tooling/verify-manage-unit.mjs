// Acceptance: an OWNER-granted "Manage Unit" user (users.businessManageIds)
// gets owner-equivalent management of ONLY the granted unit — Edit, Business
// Type, online-ordering/service settings and Reset — while Deactivate (status)
// and Delete stay OWNER-only. Applies per-business across types/branches.
//
//   node dev-tooling/verify-manage-unit.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };

const client = new pg.Client(DB_URL);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0] || null;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${body.error || ""}`);
  return body.sessionToken;
}
const H = (token) => ({ "Content-Type": "application/json", "x-gomina-session": token });
const call = async (token, path, method = "GET", body = null) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: H(token), body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let testBizId = null, testBizCode = null, testUserId = null, testUserPw = null;

try {
  // ══ 1. Setup: OWNER creates a test business + a unit-manager test user ══
  console.log("── 1. Setup ──");
  const owner = await login(OWNER.email, OWNER.pw);

  const created = await call(owner, "/api/businesses", "POST", {
    name: "AUDTEST Manage-Unit Block Works",
    category: "Poultry Farm",
    region: "Greater Accra",
    district: "Ga East",
    town: "Abokobi",
    managerName: "Test Manager",
    contactPhone: "+233 24 999 0000",
    initialCapitalGhs: 120000,
    monthlyTargetRevenueGhs: 60000,
  });
  ok("S1 owner creates test business", created.status === 200 && created.body?.success, `HTTP ${created.status}`);
  testBizId = created.body?.business?.id;
  testBizCode = created.body?.business?.code;

  const createdUser = await call(owner, "/api/users", "POST", {
    name: "AUDTEST Unit Manager",
    email: `audtest.unitmanager.${Date.now()}@gomina360.com`,
    role: "WORKER",
    assignedBusinessId: testBizId,
    password: "UnitMgr@123",
    businessManageIds: [testBizId],
  });
  ok("S2 owner creates test user WITH Manage-Unit grant", createdUser.status === 200 && createdUser.body?.success, `HTTP ${createdUser.status} ${createdUser.body?.error || ""}`);
  if (!createdUser.body?.success) throw new Error("test user creation failed — aborting");
  testUserId = createdUser.body?.user?.id;
  testUserPw = "UnitMgr@123";

  // Re-fetch the exact email from the create response.
  const testEmail = createdUser.body?.user?.email;
  const mgrToken = await login(testEmail, testUserPw);

  // ══ 2. Scope: the grantee sees ONLY the granted unit ══
  console.log("── 2. Grant scope ──");
  const init = await call(mgrToken, "/api/init");
  const seenBizIds = (init.body?.businesses || []).map((b) => b.id);
  ok("G1 grantee /api/init includes the granted unit", seenBizIds.includes(testBizId), JSON.stringify(seenBizIds));
  ok("G2 grantee /api/init does NOT include other seeded units", !seenBizIds.includes(1) && !seenBizIds.includes(3), JSON.stringify(seenBizIds));

  const countsOk = await call(mgrToken, `/api/businesses/${testBizId}`);
  ok("G3 grantee can read record counts of granted unit", countsOk.status === 200 && countsOk.body?.counts, `HTTP ${countsOk.status}`);
  const countsOther = await call(mgrToken, `/api/businesses/1`);
  ok("G4 grantee CANNOT read counts of another unit (403)", countsOther.status === 403, `HTTP ${countsOther.status}`);

  // ══ 3. Edit + Business Type (allowed) ══
  console.log("── 3. Edit & Business Type ──");
  const edit = await call(mgrToken, `/api/businesses/${testBizId}`, "PATCH", {
    name: "AUDTEST Renamed Block Works",
    category: "Block Factory",
    region: "Greater Accra",
    district: "Adenta",
    town: "Madina",
    managerName: "New Manager",
    contactPhone: "+233 24 888 1111",
    initialCapitalGhs: 150000,
    monthlyTargetRevenueGhs: 75000,
  });
  ok("E1 grantee can edit name/location/manager/phone/capital/targets", edit.status === 200 && edit.body?.success, `HTTP ${edit.status} ${edit.body?.error || ""}`);
  ok("E2 business-type change re-provisions the unit", edit.body?.typeChange != null && edit.body.business.category === "Block Factory", JSON.stringify(edit.body?.typeChange));
  const bizNow = await q1(`SELECT name, category, district, town, manager_name, initial_capital_ghs, monthly_target_revenue_ghs, status FROM businesses WHERE id=$1`, [testBizId]);
  ok("E3 edits persisted", bizNow.name === "AUDTEST Renamed Block Works" && bizNow.category === "Block Factory" && bizNow.manager_name === "New Manager" && Number(bizNow.initial_capital_ghs) === 150000, JSON.stringify(bizNow));

  // ══ 4. Deactivate / status — RESTRICTED ══
  console.log("── 4. Deactivate restricted ──");
  const deact = await call(mgrToken, `/api/businesses/${testBizId}`, "PATCH", { status: "INACTIVE" });
  ok("D1 grantee CANNOT deactivate (status) the unit (403)", deact.status === 403, `HTTP ${deact.status}`);
  const statusNow = (await q1(`SELECT status FROM businesses WHERE id=$1`, [testBizId])).status;
  ok("D2 unit stays ACTIVE", statusNow === "ACTIVE", statusNow);

  // ══ 5. Online ordering & service settings (allowed) ══
  console.log("── 5. Online ordering & service settings ──");
  const onl = await call(mgrToken, `/api/businesses/${testBizId}`, "PATCH", {
    onlineOrderingEnabled: false,
    pickupEnabled: true,
    deliveryEnabled: true,
    serviceRadiusKm: 12,
    serviceNote: "AUDTEST note",
    customerHelpPhone: "024 111 2222",
    momoNumber: "055 123 4567",
    momoName: "AUDTEST Payee",
    gpsLat: 5.65,
    gpsLng: -0.18,
  });
  ok("O1 grantee can save online-ordering settings", onl.status === 200 && onl.body?.success, `HTTP ${onl.status} ${onl.body?.error || ""}`);
  const onlNow = await q1(`SELECT online_ordering_enabled, service_radius_km, service_note, momo_number FROM businesses WHERE id=$1`, [testBizId]);
  ok("O2 online settings persisted", onlNow.online_ordering_enabled === false && Number(onlNow.service_radius_km) === 12 && onlNow.momo_number === "055 123 4567", JSON.stringify(onlNow));

  const areaAdd = await call(mgrToken, "/api/service-areas", "POST", { businessId: testBizId, name: "AUDTEST Area", radiusKm: 8, centerLat: 5.6, centerLng: -0.2, note: "test" });
  ok("O3 grantee can add a service area", areaAdd.status === 200 && areaAdd.body?.success, `HTTP ${areaAdd.status} ${areaAdd.body?.error || ""}`);
  const areaOther = await call(mgrToken, "/api/service-areas", "POST", { businessId: 1, name: "Sneaky" });
  ok("O4 grantee CANNOT add a service area to another unit (403)", areaOther.status === 403, `HTTP ${areaOther.status}`);

  // ══ 6. Reset Business Type (allowed) ══
  console.log("── 6. Reset ──");
  const reset = await call(mgrToken, `/api/businesses/${testBizId}`, "POST", { confirmCode: testBizCode, resetMasterLists: true });
  ok("R1 grantee can reset the granted unit", reset.status === 200 && reset.body?.success, `HTTP ${reset.status} ${reset.body?.error || ""}`);
  ok("R2 reset keeps unit (type/code/name) intact", reset.body?.reset?.code === testBizCode && reset.body.reset.category === "Block Factory", JSON.stringify(reset.body?.reset));
  const resetUsersForced = await call(mgrToken, `/api/businesses/${testBizId}`, "POST", { confirmCode: testBizCode, resetUsers: true });
  ok("R3 resetUsers flag is forced off for grantees (no un-assign)", resetUsersForced.status === 200 && resetUsersForced.body?.kept?.usersAssigned === true, JSON.stringify(resetUsersForced.body?.kept));

  // ══ 7. Delete — RESTRICTED ══
  console.log("── 7. Delete restricted ──");
  const del = await call(mgrToken, `/api/businesses/${testBizId}`, "DELETE", { confirmCode: testBizCode });
  ok("DL1 grantee CANNOT delete the unit (403)", del.status === 403, `HTTP ${del.status}`);
  ok("DL2 unit still exists", !!(await q1(`SELECT id FROM businesses WHERE id=$1`, [testBizId])));

  // ══ 8. Cross-scope write denied ══
  const otherEdit = await call(mgrToken, `/api/businesses/1`, "PATCH", { name: "Hacked" });
  ok("X1 grantee CANNOT edit another unit (403)", otherEdit.status === 403, `HTTP ${otherEdit.status}`);

  // ══ 9. A non-granted user gets nothing ══
  const workerToken = await login("comfort.agbenyega@gomina360.com", "GoMina@User13");
  const wEdit = await call(workerToken, `/api/businesses/${testBizId}`, "PATCH", { name: "Nope" });
  ok("N1 non-granted user cannot edit (403)", wEdit.status === 403, `HTTP ${wEdit.status}`);
  const wCounts = await call(workerToken, `/api/businesses/${testBizId}`);
  ok("N2 non-granted user cannot read counts (403)", wCounts.status === 403, `HTTP ${wCounts.status}`);

  // ══ 10. Changes reflected group-wide for the OWNER ══
  const ownerInit = await call(owner, "/api/init");
  const ownerBiz = (ownerInit.body?.businesses || []).find((b) => b.id === testBizId);
  ok("F1 OWNER bootstrap reflects the grantee's changes", ownerBiz?.name === "AUDTEST Renamed Block Works" && ownerBiz?.category === "Block Factory", JSON.stringify({ name: ownerBiz?.name, cat: ownerBiz?.category }));
} finally {
  // ══ cleanup ══
  try {
    const owner = await login(OWNER.email, OWNER.pw);
    if (testBizId) await call(owner, `/api/businesses/${testBizId}`, "DELETE", { confirmCode: testBizCode });
    if (testUserId) await call(owner, "/api/users", "PATCH", { userId: testUserId, isActive: false });
    console.log("  (cleanup: test business deleted, test user deactivated)");
  } catch (e) {
    console.error("  cleanup failed:", e.message);
  }
  await client.end();
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
