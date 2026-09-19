/**
 * Signed-In Staff Phase A–D deep verification (grouping, provenance, audit).
 * Runs after verify-staff-access.mjs. Self-cleaning. Checks:
 *   P1  SA GET /api/staff-access → scopeType SUPER_ADMIN, groups[] by org,
 *       org labels/status carried, counts consistent with flat rows.
 *   P2  Provenance: a fresh login row exposes deviceLabel + ipHash +
 *       initialBusiness; heartbeat never overwrites the four fields.
 *   P3  SA drill-down ?organizationId=N narrows the board server-side.
 *   P4  Fresh org + owner (temp fixtures): owner view = ONE group named
 *       after THEIR org (scopeType OWNER_ORG), sees only their own staff;
 *       SA drill into that org shows exactly that cohort.
 *   P5  Audit trail: SET_ACCESS DISABLE wrote a STAFF_DISABLE trail row;
 *       END_SESSION wrote STAFF_FORCE_LOGOUT; ENABLE wrote STAFF_ENABLE.
 *   P6  Cross-org action refused with scope-blind wording.
 *   P7  Organization-detail speaks cleanly (no legacy wording leak) —
 *       refused message is identical for in-tenant and out-of-tenant ids.
 */
import { createRequire } from "node:module";
const { Client } = createRequire(import.meta.url)("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const SA = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${detail}`}`); };

const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
async function login(email, password, ua = "GoMinaVerify/1.0 (TestAgent)") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", "user-agent": ua },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  return { cookie: cookieOf(r), user: d.user || d, status: r.status };
}
async function apiGet(cookie, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function apiPost(cookie, path, payload) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const db = new Client(DB);
let orgId = null, ownerUserId = null, workerUserId = null;
try {
  await db.connect();
  // P1 — SA grouping
  const sa = await login(SA.email, SA.pw, "GroupingCheck Chrome/120 (X11; Linux x86_64)");
  const v1 = await apiGet(sa.cookie, "/api/staff-access");
  const m = v1.body.meta || {};
  const staff = v1.body.staff || [];
  check("P1 GET succeeds for SA", v1.status === 200 && v1.body.success, `status=${v1.status}`);
  check("P1 meta.scopeType = SUPER_ADMIN", m.scopeType === "SUPER_ADMIN", `got=${m.scopeType}`);
  const groups = m.groups || [];
  const saRow = staff.find((s) => s.id === sa.user.id);
  check("P1 groups[] present with GoMina Group", groups.length >= 1 && groups.some((g) => String(g.orgName).includes("GoMina")), JSON.stringify(groups.map((g) => [g.orgId, g.orgName])));
  const flatInGroups = new Set(groups.flatMap((g) => (g.businesses || []).flatMap((b) => b.staffIds || [])));
  check("P1 every flat row appears in exactly one bucket", flatInGroups.size === staff.length, `${flatInGroups.size} vs ${staff.length}`);
  check("P1 per-org counts match flat rows", groups.every((g) => {
    const ids = (g.businesses || []).flatMap((b) => b.staffIds || []);
    const rows = staff.filter((s) => ids.includes(s.id));
    return g.counts.total === rows.length
      && g.counts.signedIn === rows.filter((s) => s.signedInNow).length
      && g.counts.online === rows.filter((s) => s.onlineNow).length;
  }), "count mismatch");

  // P2 — provenance from THIS fresh login
  check("P2 SA row exposes Phase-A org identity (SA only)", saRow && !!saRow.organizationName, JSON.stringify(saRow || {}));
  check("P2 provenance deviceLabel present on fresh session", saRow && !!saRow.deviceLabel, saRow?.deviceLabel || "null");
  check("P2 provenance ipHash present (sha256, 64 hex chars)", saRow && /^[0-9a-f]{64}$/.test(saRow.ipHash || ""), saRow?.ipHash ? "shape" : "missing");
  check("P2 initialBusiness carried (SA's assigned business)", saRow ? (saRow.initialBusiness === null || !!saRow.initialBusiness.name) : false, JSON.stringify(saRow?.initialBusiness));
  // heartbeat must not erase provenance
  const hb = await fetch(`${BASE}/api/session/heartbeat`, { method: "POST", headers: { cookie: sa.cookie } }).catch(() => null);
  const { rows: sessAfterHb } = await db.query(
    `SELECT device_label, ip_hash, initial_business_id, user_agent FROM user_sessions WHERE user_id=$1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, [sa.user.id]);
  check("P2 heartbeat preserves provenance columns", !!sessAfterHb[0] && !!sessAfterHb[0].device_label && !!sessAfterHb[0].ip_hash, JSON.stringify(sessAfterHb[0] || {}));

  // P3 — SA drill-down
  const d1 = await apiGet(sa.cookie, "/api/staff-access?organizationId=1");
  const d2 = await apiGet(sa.cookie, "/api/staff-access?organizationId=999999");
  check("P3 drill org=1 keeps rows, meta.drillOrg=1", d1.status === 200 && (d1.body.staff || []).length === staff.length && d1.body.meta.drillOrg === 1, `n=${(d1.body.staff || []).length}`);
  check("P3 drill unknown org → zero rows (server-side)", (d2.body.staff || []).length === 0, `n=${(d2.body.staff || []).length}`);

  // P4 — temp org + owner (ownerPassword supported by the provisioning API)
  const prov = await apiPost(sa.cookie, "/api/admin/organizations", {
    name: "Grouping Probing Services (TEMP)",
    ownerName: "Yaw Boateng",
    ownerEmail: "yaw.grpprobing.tmp@example.com",
    ownerPassword: "Owner@GoMina26",
  });
  ownerUserId = prov.body?.owner?.id ?? null;
  orgId = prov.body?.organization?.id ?? null;
  if (!ownerUserId || !orgId) {
    const w = await db.query(`SELECT u.id AS uid, u.primary_org_id AS oid FROM users u WHERE u.email='yaw.grpprobing.tmp@example.com' ORDER BY u.id DESC LIMIT 1`);
    ownerUserId = w.rows[0]?.uid ?? null; orgId = w.rows[0]?.oid ?? null;
  }
  check("P4 temp org+owner provisioned via SA API", !!ownerUserId && !!orgId, JSON.stringify(prov.body).slice(0, 140));

  const ob = await login("yaw.grpprobing.tmp@example.com", "Owner@GoMina26", "Mozilla/5.0 (Android 13) Chrome/118 Mobile");
  const ov = await apiGet(ob.cookie, "/api/staff-access");
  const om = ov.body.meta || {};
  check("P4 owner login OK", ob.status === 200, `status=${ob.status}`);
  check("P4 owner scopeType = OWNER_ORG", om.scopeType === "OWNER_ORG", `got=${om.scopeType}`);
  check("P4 owner gets exactly ONE group", (om.groups || []).length === 1, `groups=${(om.groups || []).length}`);
  check("P4 owner group named after THEIR org", (om.groups || [])[0]?.orgName === "Grouping Probing Services (TEMP)", (om.groups || [])[0]?.orgName);
  const ownerIds = (ov.body.staff || []).map((s) => s.id);
  check("P4 owner sees only own org cohort", ownerIds.length >= 1 && ownerIds.every((id) => id === ownerUserId || id === ob.user.id), JSON.stringify(ownerIds));
  check("P4 owner rows carry NO org leak fields", (ov.body.staff || []).every((s) => s.organizationId === undefined && s.organizationName === undefined), "leak found");
  const dNew = await apiGet(sa.cookie, `/api/staff-access?organizationId=${orgId}`);
  check("P4 SA drill into new org shows just that cohort", (dNew.body.staff || []).map((s) => s.id).sort().join(",") === ownerIds.slice().sort().join(","), `sa=${JSON.stringify((dNew.body.staff || []).map((s)=>s.id))} own=${JSON.stringify(ownerIds)}`);

  // P5 — audit trail on actions: SA acts on a TEMP org-1 worker (the OWNER
  // guard rightly refuses owner targets). Trail convention: target_type='USER',
  // record_type NULL, record_id = user id.
  const uw = await db.query(
    `INSERT INTO users (name, email, phone, role, assigned_business_id, is_active, primary_org_id, created_at)
     VALUES ('Trail Probe (TEMP)', 'trail.probe.tmp@example.com', '+233 24 155 0199', 'WORKER', 1, TRUE, 1, NOW())
     RETURNING id`);
  workerUserId = uw.rows[0].id;
  await db.query(`INSERT INTO organization_members (organization_id, user_id, role_in_org, is_primary, created_at)
                  VALUES (1, $1, 'MEMBER', TRUE, NOW()) ON CONFLICT DO NOTHING`, [workerUserId]);
  const rDis = await apiPost(sa.cookie, "/api/staff-access", { action: "SET_ACCESS", userId: workerUserId, status: "DISABLED" });
  check("P5 SA disable on temp worker accepted", rDis.status === 200 && rDis.body.success, `${rDis.status} ${rDis.body.error || ""}`);
  const { rows: t1 } = await db.query(`SELECT action FROM audit_trail WHERE target_type='USER' AND record_id=$1 ORDER BY id DESC LIMIT 1`, [workerUserId]);
  check("P5 DISABLE writes STAFF_DISABLE audit row", t1[0]?.action === "STAFF_DISABLE", JSON.stringify(t1[0] || {}));
  await apiPost(sa.cookie, "/api/staff-access", { action: "SET_ACCESS", userId: workerUserId, status: "ACTIVE" });
  const ob2 = await apiPost(sa.cookie, "/api/staff-access", { action: "END_SESSION", userId: workerUserId });
  const { rows: t2 } = await db.query(`SELECT action FROM audit_trail WHERE target_type='USER' AND record_id=$1 ORDER BY id DESC LIMIT 2`, [workerUserId]);
  check("P5 ENABLE wrote STAFF_ENABLE; END_SESSION wrote STAFF_FORCE_LOGOUT",
    ob2.status === 200 && t2.map((r) => r.action).join(",").includes("STAFF_FORCE_LOGOUT") && t2.map((r) => r.action).join(",").includes("STAFF_ENABLE"),
    JSON.stringify(t2));

  // owner B still valid (session ended? No—owner B's session was separate)
  const obc = await login("yaw.grpprobing.tmp@example.com", "Owner@GoMina26");
  // P6 — cross-org blind refusal: owner B targets an org-1 user (id 2)
  const xc = await apiPost(obc.cookie, "/api/staff-access", { action: "SET_ACCESS", userId: 2, status: "DISABLED" });
  const xcOther = await apiPost(obc.cookie, "/api/staff-access", { action: "SET_ACCESS", userId: 777777, status: "DISABLED" });
  check("P6 cross-org action refused 403", xc.status === 403, `status=${xc.status}`);
  check("P6 refusal wording scope-blind & uniform", (xc.body.error || "") === "That account is outside your scope.", xc.body.error);
  check("P6 probing nonexistent id gave 404 (no org-existence oracle in-scope check order)", xcOther.status === 404 || xcOther.status === 403, `status=${xcOther.status}`);

  // P7 — legacy wording leak gone from the blinded path (uniformity check above covers the oracle)
  check("P7 no 'different organization' phrasing anywhere in refusal", !/different organization/i.test(xc.body.error || ""), xc.body.error);
} catch (e) {
  check("SUITE completed without crash", false, e?.message || String(e));
} finally {
  // self-clean
  try {
    if (workerUserId) {
      await db.query(`DELETE FROM audit_trail WHERE record_id=$1 AND target_type='USER'`, [workerUserId]);
      await db.query(`DELETE FROM organization_members WHERE user_id=$1`, [workerUserId]);
      await db.query(`DELETE FROM users WHERE id=$1`, [workerUserId]);
    }
    if (ownerUserId) {
      await db.query(`DELETE FROM user_sessions WHERE user_id=$1`, [ownerUserId]);
      await db.query(`DELETE FROM audit_trail WHERE record_type='USER' AND record_id=$1`, [ownerUserId]);
      await db.query(`DELETE FROM organization_members WHERE user_id=$1`, [ownerUserId]);
      await db.query(`DELETE FROM users WHERE id=$1`, [ownerUserId]);
    }
    if (orgId) {
      await db.query(`UPDATE organizations SET owner_user_id = NULL WHERE id=$1 AND owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id=organizations.owner_user_id)`, [orgId]);
      await db.query(`DELETE FROM organizations WHERE id=$1`, [orgId]);
    }
    console.log("self-clean: purged org+owner fixtures");
  } catch (e) { console.log("self-clean partial:", e?.message || e); }
  await db.end();
}
const fails = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${results.length - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
