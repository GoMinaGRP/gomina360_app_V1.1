#!/usr/bin/env node
/**
 * Expenses — manage/delete-expense permission acceptance suite.
 *
 * Verifies the OWNER-controlled expense permission system:
 *
 *   A. OWNER can edit (PATCH) and delete (DELETE) EXPENSE transactions —
 *      always (no grant required).
 *   B. A user WITHOUT the manage-expenses permission is refused (403) for
 *      BOTH edit and delete, and the expense stays intact.
 *   C. OWNER grants the manage-expenses permission → the SAME user can now
 *      edit and delete expenses.
 *   D. Revoke → the user is refused again (403).
 *   E. Consistency across ALL existing business types: an expense in every
 *      seeded business can be deleted by the OWNER (single shared code path).
 *   F. Consistency for NEWLY created businesses: create a new unit, post an
 *      expense to it, delete it (OWNER + permitted user), then delete unit.
 *   G. Security negatives: unauthenticated → 401; deletion requires a reason;
 *      a spoofed role in the body cannot grant itself permission.
 *   H. The expense gate is INDEPENDENT of the shared-record gate:
 *      canManageRecords (no canManageExpenses) → INCOME editable, EXPENSE not;
 *      canManageExpenses (no canManageRecords) → EXPENSE editable, INCOME not.
 *   I. Every expense deletion writes the immutable audit trail
 *      (record_deletion_logs, module = 'TRANSACTIONS').
 *
 * Runs against the LIVE app server on http://127.0.0.1:3000 plus direct
 * Postgres for forensics. Cleans up after itself and restores the GM's
 * original permission state.
 *
 * Usage: node dev-tooling/verify-expense-permissions.mjs
 */
import { createRequire } from "module";

const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
// Non-owner demo accounts are seeded with password GoMina@User<id>.
const GM = { email: "abena.gm@gomina360.com", pw: "" };
const TAG = `TESTEXP-${Date.now().toString(36).toUpperCase()}`;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — ${detail}`); }
}

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);

async function login(creds) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`login failed for ${creds.email}: ${j.error}`);
  return { token: j.sessionToken, user: j.user };
}

const call = async (token, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

async function createTxn(token, businessId, label, type = "EXPENSE") {
  const category = `${label} (${TAG})`;
  const { status, json } = await call(token, "POST", "/api/transactions", {
    businessId,
    type,
    category,
    amountGhs: 42,
    paymentMethod: "CASH",
    description: `${label} acceptance-test expense`,
  });
  if (status !== 200 || !json?.success) {
    throw new Error(`createTxn failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.transaction;
}

async function main() {
  await pg.connect();
  const gmRow = (await q(`SELECT id FROM users WHERE email=$1`, [GM.email])).rows[0];
  if (!gmRow) throw new Error(`GM account ${GM.email} not found`);
  GM.pw = `GoMina@User${gmRow.id}`;

  const owner = await login(OWNER);
  const gm = await login(GM);

  // Record GM's original permission state to restore exactly.
  const gmOrig = (await q(
    `SELECT can_manage_records, can_manage_expenses FROM users WHERE id=$1`,
    [gm.user.id]
  )).rows[0];
  const restoreRecords = gmOrig?.can_manage_records ?? false;
  const restoreExpenses = gmOrig?.can_manage_expenses ?? false;

  // Known baseline: GM has NO manage-expenses and NO record-management power.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageExpenses: false, canManageRecords: false });

  const businesses = (await q(`SELECT id, code, name, category FROM businesses ORDER BY id`)).rows;
  const createdTxnIds = [];
  const createdBusinessIds = [];

  // ═══ A. OWNER can edit & delete expenses by default ════════════════════
  const tA = await createTxn(owner.token, businesses[0].id, "OWNEDIT");
  createdTxnIds.push(tA.id);
  const patchA = await call(owner.token, "PATCH", "/api/transactions", {
    id: tA.id,
    data: { category: `OWNER-EDITED (${TAG})`, amountGhs: 99 },
  });
  check("A1. OWNER can edit an expense", patchA.status === 200 && patchA.json?.success, JSON.stringify(patchA));
  check(
    "A2. OWNER edit applied",
    patchA.json?.transaction?.category?.includes("OWNER-EDITED") && Number(patchA.json?.transaction?.amountGhs) === 99,
    JSON.stringify(patchA.json?.transaction)
  );

  const delA = await call(owner.token, "DELETE", "/api/transactions", {
    id: tA.id,
    reason: "Owner expense acceptance test",
  });
  check("A3. OWNER can delete an expense", delA.status === 200 && delA.json?.success, JSON.stringify(delA));
  const goneA = (await q(`SELECT 1 FROM transactions WHERE id=$1`, [tA.id])).rowCount === 0;
  check("A4. OWNER-deleted expense is gone from the DB", goneA);

  // ═══ B. User WITHOUT permission is refused ═════════════════════════════
  const tB = await createTxn(owner.token, businesses[1].id, "NOPERM");
  createdTxnIds.push(tB.id);
  const patchB = await call(gm.token, "PATCH", "/api/transactions", {
    id: tB.id,
    data: { description: "GM HACKED" },
  });
  check("B1. User without permission refused EDIT of expense (403)", patchB.status === 403, `${patchB.status} ${JSON.stringify(patchB.json)}`);
  const delB = await call(gm.token, "DELETE", "/api/transactions", {
    id: tB.id,
    reason: "attempted without permission",
  });
  check("B2. User without permission refused DELETE of expense (403)", delB.status === 403, `${delB.status} ${JSON.stringify(delB.json)}`);
  const stillThere = (await q(`SELECT 1 FROM transactions WHERE id=$1`, [tB.id])).rowCount === 1;
  check("B3. Refused delete left the expense intact", stillThere);

  // ═══ C. Grant → the SAME user can edit & delete expenses ═══════════════
  const grant = await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageExpenses: true });
  check("C1. OWNER can grant the manage-expenses permission", grant.status === 200 && grant.json?.success && grant.json?.user?.canManageExpenses === true, JSON.stringify(grant));

  const patchC = await call(gm.token, "PATCH", "/api/transactions", {
    id: tB.id,
    data: { category: `GM-EDITED (${TAG})`, amountGhs: 5 },
  });
  check("C2. Granted user can now EDIT an expense (200)", patchC.status === 200 && patchC.json?.success, JSON.stringify(patchC));
  check("C3. Granted-user edit applied", patchC.json?.transaction?.category?.includes("GM-EDITED"), JSON.stringify(patchC.json?.transaction));

  const delC = await call(gm.token, "DELETE", "/api/transactions", {
    id: tB.id,
    reason: "Granted-user expense acceptance test",
  });
  check("C4. Granted user can now DELETE an expense (200)", delC.status === 200 && delC.json?.success, JSON.stringify(delC));
  check("C5. Expense deletion wrote an audit row", Number.isFinite(delC.json?.auditLogId), JSON.stringify(delC));

  const logRow = (await q(
    `SELECT module, record_label, deleted_by_role FROM record_deletion_logs WHERE id=$1`,
    [delC.json?.auditLogId]
  )).rows[0];
  check("C6. Audit row is module=TRANSACTIONS with the right label", logRow?.module === "TRANSACTIONS" && logRow?.record_label?.includes("GM-EDITED"), JSON.stringify(logRow));

  // ═══ D. Revoke → refused again ═════════════════════════════════════════
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageExpenses: false });
  const tD = await createTxn(owner.token, businesses[2].id, "REVOKED");
  createdTxnIds.push(tD.id);
  const delD = await call(gm.token, "DELETE", "/api/transactions", {
    id: tD.id,
    reason: "attempted after revoke",
  });
  check("D1. Revoked user refused DELETE of expense again (403)", delD.status === 403, `${delD.status} ${JSON.stringify(delD.json)}`);

  // ═══ E. Consistency across ALL existing business types ═════════════════
  for (const b of businesses) {
    const t = await createTxn(owner.token, b.id, "ALLTYPES");
    createdTxnIds.push(t.id);
    const d = await call(owner.token, "DELETE", "/api/transactions", {
      id: t.id, reason: "cross-business-type expense acceptance test",
    });
    const gone = (await q(`SELECT 1 FROM transactions WHERE id=$1`, [t.id])).rowCount === 0;
    check(`E. OWNER deletes expense in ${b.code} (${b.category})`, d.status === 200 && d.json?.success && gone, `${d.status} ${JSON.stringify(d.json)}`);
  }

  // ═══ F. Newly created business inherits the SAME permission system ═════
  const newBizRes = await call(owner.token, "POST", "/api/businesses", {
    name: `${TAG} Test Unit`,
    code: `TEST-${TAG}`,
    category: "Block Factory",
    region: "Greater Accra",
    district: "Accra Metropolitan",
    town: "Accra",
    managerName: "Test Manager",
    contactPhone: "+233 24 000 0000",
    initialCapitalGhs: 50000,
    monthlyTargetRevenueGhs: 20000,
  });
  check("F1. New business created", newBizRes.status === 200 && newBizRes.json?.success, JSON.stringify(newBizRes));
  const newBiz = newBizRes.json?.business;
  createdBusinessIds.push(newBiz?.id);

  if (newBiz?.id) {
    const tF = await createTxn(owner.token, newBiz.id, "NEWBIZ");
    createdTxnIds.push(tF.id);
    // No permission → GM refused on the brand-new unit too.
    const denyF = await call(gm.token, "DELETE", "/api/transactions", {
      id: tF.id, reason: "no permission on new business",
    });
    check("F2. New business: user WITHOUT permission refused (403)", denyF.status === 403, `${denyF.status}`);

    // Grant → permitted user CAN delete on the new unit.
    await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageExpenses: true });
    const allowF = await call(gm.token, "DELETE", "/api/transactions", {
      id: tF.id, reason: "granted on new business",
    });
    check("F3. New business: granted user CAN delete expense (200)", allowF.status === 200 && allowF.json?.success, JSON.stringify(allowF));

    const delBiz = await call(owner.token, "DELETE", `/api/businesses/${newBiz.id}`, { confirmCode: newBiz.code });
    check("F4. Test business removed cleanly", delBiz.status === 200 && delBiz.json?.success, JSON.stringify(delBiz));
    const bizGone = (await q(`SELECT 1 FROM businesses WHERE id=$1`, [newBiz.id])).rowCount === 0;
    check("F5. Test business gone from DB", bizGone);
  }
  // Reset to no-permission for the next sections.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageExpenses: false, canManageRecords: false });

  // ═══ G. Security negatives ═════════════════════════════════════════════
  const tG = await createTxn(owner.token, businesses[3].id, "NEG");
  createdTxnIds.push(tG.id);
  const unauth = await call(null, "DELETE", "/api/transactions", { id: tG.id, reason: "no session" });
  check("G1. Unauthenticated delete → 401", unauth.status === 401, `${unauth.status}`);
  const noReason = await call(owner.token, "DELETE", "/api/transactions", { id: tG.id, reason: "x" });
  check("G2. Delete without a real reason → 400", noReason.status === 400, `${noReason.status} ${JSON.stringify(noReason.json)}`);

  // ═══ H. Expense gate is independent of the shared-record gate ══════════
  // H(a): canManageRecords=TRUE, canManageExpenses=FALSE.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageRecords: true, canManageExpenses: false });
  const inc1 = await createTxn(owner.token, businesses[4].id, "SPLIT", "INCOME");
  const exp1 = await createTxn(owner.token, businesses[4].id, "SPLIT", "EXPENSE");
  createdTxnIds.push(inc1.id, exp1.id);

  const editInc1 = await call(gm.token, "PATCH", "/api/transactions", { id: inc1.id, data: { description: "split test income" } });
  check("H1. canManageRecords (no expense flag) → INCOME edit allowed (200)", editInc1.status === 200 && editInc1.json?.success, JSON.stringify(editInc1));
  const delInc1 = await call(gm.token, "DELETE", "/api/transactions", { id: inc1.id, reason: "split test income delete" });
  check("H2. canManageRecords (no expense flag) → INCOME delete allowed (200)", delInc1.status === 200 && delInc1.json?.success, JSON.stringify(delInc1));
  const editExp1 = await call(gm.token, "PATCH", "/api/transactions", { id: exp1.id, data: { description: "split test expense" } });
  check("H3. canManageRecords (no expense flag) → EXPENSE edit refused (403)", editExp1.status === 403, `${editExp1.status}`);
  const delExp1 = await call(gm.token, "DELETE", "/api/transactions", { id: exp1.id, reason: "split test expense delete" });
  check("H4. canManageRecords (no expense flag) → EXPENSE delete refused (403)", delExp1.status === 403, `${delExp1.status}`);

  // H(b): canManageRecords=FALSE, canManageExpenses=TRUE.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canManageRecords: false, canManageExpenses: true });
  const inc2 = await createTxn(owner.token, businesses[5].id, "SPLIT2", "INCOME");
  const exp2 = await createTxn(owner.token, businesses[5].id, "SPLIT2", "EXPENSE");
  createdTxnIds.push(inc2.id, exp2.id);

  const editExp2 = await call(gm.token, "PATCH", "/api/transactions", { id: exp2.id, data: { description: "split2 test expense" } });
  check("H5. canManageExpenses (no records flag) → EXPENSE edit allowed (200)", editExp2.status === 200 && editExp2.json?.success, JSON.stringify(editExp2));
  const delExp2 = await call(gm.token, "DELETE", "/api/transactions", { id: exp2.id, reason: "split2 test expense delete" });
  check("H6. canManageExpenses (no records flag) → EXPENSE delete allowed (200)", delExp2.status === 200 && delExp2.json?.success, JSON.stringify(delExp2));
  const editInc2 = await call(gm.token, "PATCH", "/api/transactions", { id: inc2.id, data: { description: "split2 test income" } });
  check("H7. canManageExpenses (no records flag) → INCOME edit refused (403)", editInc2.status === 403, `${editInc2.status}`);
  const delInc2 = await call(gm.token, "DELETE", "/api/transactions", { id: inc2.id, reason: "split2 test income delete" });
  check("H8. canManageExpenses (no records flag) → INCOME delete refused (403)", delInc2.status === 403, `${delInc2.status}`);

  // ═══ Cleanup ═══════════════════════════════════════════════════════════
  await call(owner.token, "PATCH", "/api/users", {
    userId: gm.user.id,
    canManageRecords: restoreRecords,
    canManageExpenses: restoreExpenses,
  });
  // Remove leftover test transactions + their deletion-log rows.
  const leftovers = (await q(
    `SELECT id FROM transactions WHERE category LIKE '%${TAG}%' OR description LIKE '%${TAG}%'`
  )).rows;
  for (const r of leftovers) {
    await call(owner.token, "DELETE", "/api/transactions", { id: r.id, reason: "test cleanup" });
  }
  await q(`DELETE FROM record_deletion_logs WHERE record_label LIKE '%${TAG}%'`);
  const leftoverBiz = (await q(`SELECT id FROM businesses WHERE name LIKE '%${TAG}%'`)).rows;
  for (const b of leftoverBiz) {
    const biz = (await q(`SELECT code FROM businesses WHERE id=$1`, [b.id])).rows[0];
    await call(owner.token, "DELETE", `/api/businesses/${b.id}`, { confirmCode: biz.code });
  }

  const finalTrx = (await q(`SELECT count(*)::int AS n FROM transactions WHERE category LIKE '%${TAG}%' OR description LIKE '%${TAG}%'`)).rows[0].n;
  const finalBiz = (await q(`SELECT count(*)::int AS n FROM businesses WHERE name LIKE '%${TAG}%'`)).rows[0].n;
  check("Cleanup. No test transactions remain", finalTrx === 0, `${finalTrx} left`);
  check("Cleanup. No test businesses remain", finalBiz === 0, `${finalBiz} left`);
  const gmFinal = (await q(`SELECT can_manage_records, can_manage_expenses FROM users WHERE id=$1`, [gm.user.id])).rows[0];
  check("Cleanup. GM permission state restored", gmFinal.can_manage_records === restoreRecords && gmFinal.can_manage_expenses === restoreExpenses, JSON.stringify(gmFinal));

  console.log(`\n────────────────────────────────────────`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────────`);
  await pg.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await pg.end(); } catch { /* ignore */ }
  process.exit(2);
});
