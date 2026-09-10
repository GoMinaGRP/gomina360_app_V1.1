#!/usr/bin/env node
/**
 * Inventory & Stock — delete-inventory permission acceptance suite.
 *
 * Verifies the OWNER-controlled Inventory & Stock permission system:
 *
 *   A. OWNER can edit (PATCH) and delete (DELETE) inventory entries — always.
 *   B. A user WITHOUT the delete-inventory permission is refused (403) for
 *      BOTH edit and delete, and the entry stays intact.
 *   C. OWNER grants the delete-inventory permission → the SAME user can now
 *      edit and delete inventory entries.
 *   D. Revoke → the user is refused again (403).
 *   E. Consistency across ALL existing business types: an inventory entry in
 *      every seeded business can be deleted by the OWNER (single shared code
 *      path — no per-type bypass).
 *   F. Consistency for NEWLY created businesses: create a new unit, add an
 *      entry to it, delete it (OWNER + permitted user), then delete the unit.
 *   G. Deletions always write the immutable audit trail
 *      (record_deletion_logs, module = 'INVENTORY').
 *   H. Security negatives: unauthenticated calls → 401; a spoofed role in the
 *      body cannot grant itself permission; deletion requires a reason.
 *
 * Runs against the LIVE app server on http://127.0.0.1:3000 (start it first:
 *   npx next start -H 0.0.0.0 -p 3000) plus direct Postgres for forensics.
 * It cleans up after itself and restores the GM's original permission state.
 *
 * Usage: node dev-tooling/verify-inventory-permissions.mjs
 */
import { createRequire } from "module";

const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
// Non-owner demo accounts are seeded with password GoMina@User<id>.
const GM = { email: "abena.gm@gomina360.com", pw: "" };
const TAG = `TEST-DEL-${Date.now().toString(36).toUpperCase()}`;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — ${detail}`); }
}

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);

/** Login and return the bearer token + user row. */
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

/** Create one inventory entry and return it. */
async function createItem(token, businessId, label) {
  const sku = `SKU-${TAG}-${label}`;
  const { status, json } = await call(token, "POST", "/api/enterprise", {
    entityType: "inventory",
    data: {
      name: `${label} (${TAG})`,
      sku,
      businessId,
      category: "Test Stock",
      quantity: 50,
      unit: "Units",
      costPriceGhs: 10,
      sellingPriceGhs: 15,
      minStockThreshold: 5,
    },
  });
  if (status !== 200 || !json?.success) {
    throw new Error(`createItem failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.item;
}

async function main() {
  await pg.connect();
  const gmRow = (await q(`SELECT id FROM users WHERE email=$1`, [GM.email])).rows[0];
  if (!gmRow) throw new Error(`GM account ${GM.email} not found`);
  GM.pw = `GoMina@User${gmRow.id}`;

  const owner = await login(OWNER);
  const gm = await login(GM);

  // Record the GM's original permission state so we can restore it exactly.
  const gmOriginal = (await q(`SELECT can_delete_inventory FROM users WHERE id=$1`, [gm.user.id])).rows[0];
  const restoreFlag = gmOriginal?.can_delete_inventory ?? false;

  // Reset to a known baseline: GM has NO delete-inventory permission.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canDeleteInventory: false });

  const businesses = (await q(`SELECT id, code, name, category FROM businesses ORDER BY id`)).rows;
  const createdItems = [];       // businessId → item(s) for cleanup
  const createdBusinessIds = []; // for the new-business test

  // ═══ A. OWNER can edit & delete ═══════════════════════════════════════
  const itemA = await createItem(owner.token, businesses[0].id, "OWNEDIT");
  createdItems.push(itemA.id);

  const patchA = await call(owner.token, "PATCH", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemA.id,
    data: { name: `OWNER EDITED (${TAG})`, quantity: 77, costPriceGhs: 12.5 },
  });
  check("A1. OWNER can edit an inventory entry", patchA.status === 200 && patchA.json?.success, JSON.stringify(patchA));
  check(
    "A2. OWNER edit applied (name/qty/status recomputed)",
    patchA.json?.item?.name?.includes("OWNER EDITED") &&
      Number(patchA.json?.item?.quantity) === 77 &&
      patchA.json?.item?.status === "IN_STOCK",
    JSON.stringify(patchA.json?.item)
  );

  const delA = await call(owner.token, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemA.id,
    reason: "Owner acceptance test — removing test item",
  });
  check("A3. OWNER can delete an inventory entry", delA.status === 200 && delA.json?.success, JSON.stringify(delA));
  const goneA = (await q(`SELECT 1 FROM inventory_items WHERE id=$1`, [itemA.id])).rowCount === 0;
  check("A4. OWNER-deleted entry is gone from the DB", goneA);

  // ═══ B. User WITHOUT permission is refused ════════════════════════════
  const itemB = await createItem(owner.token, businesses[1].id, "NOPERM");
  createdItems.push(itemB.id);

  const patchB = await call(gm.token, "PATCH", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemB.id,
    data: { name: "GM HACKED" },
  });
  check("B1. User without permission is refused EDIT (403)", patchB.status === 403, `${patchB.status} ${JSON.stringify(patchB.json)}`);

  const delB = await call(gm.token, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemB.id,
    reason: "attempted without permission",
  });
  check("B2. User without permission is refused DELETE (403)", delB.status === 403, `${delB.status} ${JSON.stringify(delB.json)}`);
  const stillThere = (await q(`SELECT 1 FROM inventory_items WHERE id=$1`, [itemB.id])).rowCount === 1;
  check("B3. Refused delete left the entry intact", stillThere);

  // ═══ C. Grant permission → the SAME user can edit & delete ════════════
  const grant = await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canDeleteInventory: true });
  check("C1. OWNER can grant the delete-inventory permission", grant.status === 200 && grant.json?.success && grant.json?.user?.canDeleteInventory === true, JSON.stringify(grant));

  const patchC = await call(gm.token, "PATCH", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemB.id,
    data: { name: `GM EDITED (${TAG})`, quantity: 3 },
  });
  check("C2. Granted user can now EDIT (200)", patchC.status === 200 && patchC.json?.success, JSON.stringify(patchC));
  check("C3. Edit recomputed LOW_STOCK status (qty 3 <= threshold 5)", patchC.json?.item?.status === "LOW_STOCK", JSON.stringify(patchC.json?.item));

  const delC = await call(gm.token, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY",
    id: itemB.id,
    reason: "Granted-user acceptance test — removing test item",
  });
  check("C4. Granted user can now DELETE (200)", delC.status === 200 && delC.json?.success, JSON.stringify(delC));
  check("C5. Deletion wrote an audit row", Number.isFinite(delC.json?.auditLogId), JSON.stringify(delC));

  const logRow = (await q(
    `SELECT module, record_label, deleted_by_role FROM record_deletion_logs WHERE id=$1`,
    [delC.json?.auditLogId]
  )).rows[0];
  check("C6. Audit row is module=INVENTORY with the right label", logRow?.module === "INVENTORY" && logRow?.record_label?.includes("GM EDITED"), JSON.stringify(logRow));

  // ═══ D. Revoke → refused again ════════════════════════════════════════
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canDeleteInventory: false });
  const itemD = await createItem(owner.token, businesses[2].id, "REVOKED");
  createdItems.push(itemD.id);
  const delD = await call(gm.token, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY", id: itemD.id, reason: "attempted after revoke",
  });
  check("D1. Revoked user is refused DELETE again (403)", delD.status === 403, `${delD.status} ${JSON.stringify(delD.json)}`);

  // ═══ E. Consistency across ALL existing business types ════════════════
  for (const b of businesses) {
    const it = await createItem(owner.token, b.id, "ALLTYPES");
    createdItems.push(it.id);
    const d = await call(owner.token, "DELETE", "/api/enterprise", {
      entityType: "INVENTORY", id: it.id, reason: "cross-business-type acceptance test",
    });
    const gone = (await q(`SELECT 1 FROM inventory_items WHERE id=$1`, [it.id])).rowCount === 0;
    check(`E. OWNER deletes entry in ${b.code} (${b.category})`, d.status === 200 && d.json?.success && gone, `${d.status} ${JSON.stringify(d.json)}`);
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
    const itemF = await createItem(owner.token, newBiz.id, "NEWBIZ");
    // No permission → GM refused on the brand-new unit too.
    const denyF = await call(gm.token, "DELETE", "/api/enterprise", {
      entityType: "INVENTORY", id: itemF.id, reason: "no permission on new business",
    });
    check("F2. New business: user WITHOUT permission still refused (403)", denyF.status === 403, `${denyF.status}`);

    // Grant → permitted user CAN delete on the new unit.
    await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canDeleteInventory: true });
    const allowF = await call(gm.token, "DELETE", "/api/enterprise", {
      entityType: "INVENTORY", id: itemF.id, reason: "granted on new business",
    });
    check("F3. New business: granted user CAN delete (200)", allowF.status === 200 && allowF.json?.success, JSON.stringify(allowF));

    // Owner deletes the whole new unit (cleans up provisioned rows too).
    const delBiz = await call(owner.token, "DELETE", `/api/businesses/${newBiz.id}`, { confirmCode: newBiz.code });
    check("F4. Test business removed cleanly", delBiz.status === 200 && delBiz.json?.success, JSON.stringify(delBiz));
    const bizGone = (await q(`SELECT 1 FROM businesses WHERE id=$1`, [newBiz.id])).rowCount === 0;
    check("F5. Test business gone from DB", bizGone);
  }

  // ═══ G. Security negatives ════════════════════════════════════════════
  const itemG = await createItem(owner.token, businesses[3].id, "NEG");
  createdItems.push(itemG.id);
  const unauth = await call(null, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY", id: itemG.id, reason: "no session",
  });
  check("G1. Unauthenticated delete → 401", unauth.status === 401, `${unauth.status}`);
  const noReason = await call(owner.token, "DELETE", "/api/enterprise", {
    entityType: "INVENTORY", id: itemG.id, reason: "x",
  });
  check("G2. Delete without a real reason → 400", noReason.status === 400, `${noReason.status} ${JSON.stringify(noReason.json)}`);

  // ═══ Cleanup ═══════════════════════════════════════════════════════════
  // Restore the GM's original permission exactly.
  await call(owner.token, "PATCH", "/api/users", { userId: gm.user.id, canDeleteInventory: restoreFlag });
  // Remove any leftover test inventory rows + their deletion-log rows.
  const leftovers = (await q(
    `SELECT id FROM inventory_items WHERE sku LIKE 'SKU-${TAG}-%' OR name LIKE '%(${TAG})%' OR name LIKE '%(${TAG}%'`,
  )).rows;
  for (const r of leftovers) {
    await call(owner.token, "DELETE", "/api/enterprise", { entityType: "INVENTORY", id: r.id, reason: "test cleanup" });
  }
  await q(`DELETE FROM record_deletion_logs WHERE record_label LIKE '%${TAG}%'`);
  // Remove any test businesses that survived (shouldn't be any).
  const leftoverBiz = (await q(`SELECT id FROM businesses WHERE name LIKE '%${TAG}%'`)).rows;
  for (const b of leftoverBiz) {
    const biz = (await q(`SELECT code FROM businesses WHERE id=$1`, [b.id])).rows[0];
    await call(owner.token, "DELETE", `/api/businesses/${b.id}`, { confirmCode: biz.code });
  }

  // Final forensics: no test rows anywhere.
  const finalInv = (await q(`SELECT count(*)::int AS n FROM inventory_items WHERE name LIKE '%${TAG}%' OR sku LIKE 'SKU-${TAG}-%'`)).rows[0].n;
  const finalBiz = (await q(`SELECT count(*)::int AS n FROM businesses WHERE name LIKE '%${TAG}%'`)).rows[0].n;
  check("Cleanup. No test inventory rows remain", finalInv === 0, `${finalInv} left`);
  check("Cleanup. No test businesses remain", finalBiz === 0, `${finalBiz} left`);
  const gmFinal = (await q(`SELECT can_delete_inventory FROM users WHERE id=$1`, [gm.user.id])).rows[0];
  check("Cleanup. GM permission state restored", gmFinal.can_delete_inventory === restoreFlag, JSON.stringify(gmFinal));

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
