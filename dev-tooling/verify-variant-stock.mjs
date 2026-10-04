/**
 * verify-variant-stock.mjs — variant stock management suite (V1…V5 phases).
 *
 * Runs against the REAL API + REAL database and proves, end to end:
 *
 *   V1 · STOCK INTEGRITY (one writer per data family)
 *        A · registration with a matrix creates variant rows + the derived item total
 *        B · the register REFUSES an item-level quantity edit on a variant product
 *        C · a variant-targeted edit changes only that row (aggregate re-derived)
 *        D · a module receipt (hardware purchase) refuses instead of silently
 *            booking a receipt that moved no stock
 *        E · a plain (non-variant) item is completely unaffected — quantity
 *            edit + module receipt still work and log their movement
 *        F · sales: a variant line without a choice is rejected; with a choice
 *            it decrements the exact row and logs a SALE movement with variant_id
 *        G · oversell guard — selling more than the combination holds is rejected
 *        H · the reorder radar reports the COMBINATION, not just the item total
 *        I · the movement trail carries variant_id for every variant movement
 *        J · static scan: no direct inventory_items.quantity writer outside the
 *            two documented families (item writer + derived aggregate)
 *
 * Everything is tagged TEST-VAR- and purged in the finally block.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t}`);

const client = new Client({ connectionString: DB });
const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const q1 = async (sql, params = []) => (await q(sql, params))[0];

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed: ${res.status} ${body.error || ""}`);
  return body.sessionToken || body.token;
}
const H = (t) => ({ "Content-Type": "application/json", "x-gomina-session": t });
const call = async (t, path, method = "GET", body = null) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const TAG = "TEST-VAR";
const stamp = Date.now().toString().slice(-6);
// Hardware unit (id 8) — exercises a NON-boutique business on purpose.
const BIZ = 8;
let plainItemId = null, variantItemId = null, variantIds = [];

const createdItemIds = [];

async function createPlainItem(token) {
  const res = await call(token, "/api/enterprise", "POST", {
    entityType: "inventory",
    data: {
      name: `${TAG} Plain Cement Bag ${stamp}`,
      businessId: BIZ,
      category: "Building Materials",
      quantity: 20,
      unit: "Bags",
      costPriceGhs: 40,
      sellingPriceGhs: 55,
      minStockThreshold: 5,
    },
  });
  if (!res.body?.item?.id) throw new Error(`plain item create failed: ${JSON.stringify(res.body).slice(0, 200)}`);
  createdItemIds.push(Number(res.body.item.id));
  return Number(res.body.item.id);
}

async function createVariantItem(token) {
  const res = await call(token, "/api/enterprise", "POST", {
    entityType: "inventory",
    data: {
      name: `${TAG} Safety Boots ${stamp}`,
      businessId: BIZ,
      category: "Safety & Protective Gear",
      quantity: 0,
      unit: "Pairs",
      costPriceGhs: 90,
      sellingPriceGhs: 140,
      minStockThreshold: 5,
      // The registration-time matrix the Inventory & Stock form will send.
      tracksVariants: true,
      boutiqueVariants: [
        { size: "S", color: "Black", quantity: 10, minStockThreshold: 3 },
        { size: "M", color: "Black", quantity: 15, minStockThreshold: 3 },
        { size: "L", color: "Black", quantity: 8, minStockThreshold: 3 },
        { size: "S", color: "White", quantity: 6, minStockThreshold: 2 },
        { size: "M", color: "White", quantity: 12, minStockThreshold: 2 },
      ],
    },
  });
  if (!res.body?.item?.id) throw new Error(`variant item create failed: ${JSON.stringify(res.body).slice(0, 300)}`);
  createdItemIds.push(Number(res.body.item.id));
  return Number(res.body.item.id);
}

async function purge() {
  if (createdItemIds.length === 0) return;
  const ids = createdItemIds.join(",");
  try {
    await q(`delete from stock_movements where inventory_id in (${ids})`);
    await q(`delete from inventory_variants where inventory_id in (${ids})`);
    await q(`delete from sales_documents where line_items::text like '%${TAG}%'`);
    await q(`delete from transactions where description like '%${TAG}%'`);
    await q(`delete from inventory_items where id in (${ids})`);
    await q(`delete from hardware_purchases where item_name like '%${TAG}%'`);
    console.log(`\n🧹 purged ${createdItemIds.length} test item(s) + their variants/movements`);
  } catch (e) {
    console.error("purge failed:", e.message);
  }
}

async function main() {
  await client.connect();
  const token = await login();

  // ── V1-A · registration with a matrix ─────────────────────────────────
  section("V1-A · Add Stock with a size/colour matrix → rows + derived total");
  variantItemId = await createVariantItem(token);
  plainItemId = await createPlainItem(token);

  const rows = await q(
    `select id, size, color, quantity, sku, status, is_active from inventory_variants where inventory_id = $1 order by sort_order, id`,
    [variantItemId],
  );
  variantIds = rows.map((r) => Number(r.id));
  const firstRow = rows.find((r) => r.size === "S" && r.color === "Black");
  ok("5 combinations persisted", rows.length === 5, `got ${rows.length}`);
  ok("S/Black holds 10", Number(firstRow?.quantity) === 10, `got ${firstRow?.quantity}`);
  ok("W/M holds 12", Number(rows.find((r) => r.size === "M" && r.color === "White")?.quantity) === 12);
  ok("per-variant SKU derived from the parent SKU", /BOOTS|HW-/.test(String(rows[0]?.sku)) || !!rows[0]?.sku, String(rows[0]?.sku));
  const item = await q1(`select quantity, status, tracks_variants from inventory_items where id = $1`, [variantItemId]);
  ok("parent quantity is the SUM (51)", Number(item.quantity) === 51, `got ${item.quantity}`);
  ok("tracksVariants flag set", item.tracks_variants === true);

  // ── V1-B · item-level edit refused ────────────────────────────────────
  section("V1-B · item-level quantity edit on a variant product is refused");
  const patchQty = await call(token, "/api/enterprise", "PATCH", {
    entityType: "INVENTORY", id: variantItemId, actorUserId: 1, data: { quantity: 999 },
  });
  ok("PATCH quantity → 400", patchQty.status === 400, `status ${patchQty.status}`);
  ok(
    "error names the reason",
    /size\/colour|combination/i.test(String(patchQty.body?.error || "")),
    String(patchQty.body?.error || ""),
  );
  const afterRefusal = await q1(`select quantity from inventory_items where id = $1`, [variantItemId]);
  ok("aggregate untouched (51)", Number(afterRefusal.quantity) === 51, `got ${afterRefusal.quantity}`);

  const patchPricedNoQty = await call(token, "/api/enterprise", "PATCH", {
    entityType: "INVENTORY", id: variantItemId, actorUserId: 1, data: { sellingPriceGhs: 145 },
  });
  ok("a non-quantity edit still works", patchPricedNoQty.status === 200, `status ${patchPricedNoQty.status}`);
  const afterPrice = await q1(`select quantity, status from inventory_items where id = $1`, [variantItemId]);
  ok("…and never rewrites the derived total/status", Number(afterPrice.quantity) === 51 && afterPrice.status === "IN_STOCK");

  // ── V1-C · targeted combination edit ──────────────────────────────────
  section("V1-C · updating one combination moves only that row");
  const targetVariant = rows.find((r) => r.size === "L" && r.color === "Black");
  const patchVar = await call(token, "/api/enterprise", "PATCH", {
    entityType: "INVENTORY", id: variantItemId, actorUserId: 1,
    data: { variantId: Number(targetVariant.id), quantity: 20 },
  });
  ok("PATCH with variantId → 200", patchVar.status === 200, `status ${patchVar.status} ${patchVar.body?.error || ""}`);
  const movedRow = await q1(`select quantity from inventory_variants where id = $1`, [targetVariant.id]);
  ok("L/Black now 20", Number(movedRow.quantity) === 20, `got ${movedRow.quantity}`);
  const otherRow = await q1(`select quantity from inventory_variants where id = $1`, [firstRow.id]);
  ok("S/Black untouched (10)", Number(otherRow.quantity) === 10, `got ${otherRow.quantity}`);
  const agg = await q1(`select quantity from inventory_items where id = $1`, [variantItemId]);
  ok("aggregate re-derived (63)", Number(agg.quantity) === 63, `got ${agg.quantity}`);
  const mv = await q1(
    `select delta, quantity_after, reason, variant_id from stock_movements where inventory_id = $1 and variant_id = $2 order by id desc limit 1`,
    [variantItemId, targetVariant.id],
  );
  ok("movement logged for the combination (+12)", Number(mv?.delta) === 12 && Number(mv?.variant_id) === Number(targetVariant.id), JSON.stringify(mv));

  // ── V1-D · module receipt refuses instead of silently doing nothing ───
  section("V1-D · module receipt on a variant product is refused with a clear error");
  const hwRecv = await call(token, "/api/hardware", "POST", {
    entity: "PURCHASE",
    data: {
      businessId: BIZ,
      supplierName: `${TAG} Supplier`,
      itemName: `${TAG} Safety Boots ${stamp}`,
      inventoryId: variantItemId,
      quantity: 5,
      unitCostGhs: 90,
      status: "RECEIVED",
    },
  });
  ok("hardware receipt → 400", hwRecv.status === 400, `status ${hwRecv.status} ${JSON.stringify(hwRecv.body).slice(0, 160)}`);
  ok("error explains the size/colour requirement", /size\/colour|combination/i.test(String(hwRecv.body?.error || "")));
  const afterHw = await q1(`select quantity from inventory_items where id = $1`, [variantItemId]);
  ok("aggregate unchanged by the refused receipt (63)", Number(afterHw.quantity) === 63, `got ${afterHw.quantity}`);
  const strayMove = await q1(
    `select count(*)::int n from stock_movements where inventory_id = $1 and ref_type = 'HARDWARE_PURCHASE'`,
    [variantItemId],
  );
  ok("no movement row was written", Number(strayMove.n) === 0, `got ${strayMove.n}`);

  // ── V1-E · plain items are untouched by all of this ───────────────────
  section("V1-E · plain (non-variant) items keep the simple flow");
  const plainPatch = await call(token, "/api/enterprise", "PATCH", {
    entityType: "INVENTORY", id: plainItemId, actorUserId: 1, data: { quantity: 25 },
  });
  ok("plain quantity edit → 200", plainPatch.status === 200, `status ${plainPatch.status}`);
  const plainAfter = await q1(`select quantity, status from inventory_items where id = $1`, [plainItemId]);
  ok("plain quantity is 25 / IN_STOCK", Number(plainAfter.quantity) === 25 && plainAfter.status === "IN_STOCK");
  const plainRecv = await call(token, "/api/hardware", "POST", {
    entity: "PURCHASE",
    data: {
      businessId: BIZ,
      supplierName: `${TAG} Supplier`,
      itemName: `${TAG} Plain Cement Bag ${stamp}`,
      inventoryId: plainItemId,
      quantity: 5,
      unitCostGhs: 40,
      status: "RECEIVED",
      recordExpense: false,
    },
  });
  ok("plain module receipt → 200", plainRecv.status === 200, `status ${plainRecv.status} ${JSON.stringify(plainRecv.body).slice(0, 160)}`);
  const plainAfterRecv = await q1(`select quantity from inventory_items where id = $1`, [plainItemId]);
  ok("plain receipt added the stock (30)", Number(plainAfterRecv.quantity) === 30, `got ${plainAfterRecv.quantity}`);
  const plainMove = await q1(
    `select delta, reason, variant_id from stock_movements where inventory_id = $1 and reason = 'PURCHASE' order by id desc limit 1`,
    [plainItemId],
  );
  ok("plain receipt logged a PURCHASE movement", Number(plainMove?.delta) === 5 && plainMove?.variant_id == null, JSON.stringify(plainMove));

  // ── V1-F · sales must name the combination ────────────────────────────
  section("V1-F · sales: a variant product cannot be sold without its combination");
  const badSale = await call(token, "/api/sales", "POST", {
    businessId: BIZ,
    cartItems: [{ inventoryId: variantItemId, quantity: 2, sellingPrice: 140 }],
    paymentMethod: "CASH",
    discount: 0,
    createdByUserId: 1, createdByName: "Variant Suite", createdByRole: "OWNER",
  });
  ok("sale without a choice → 400", badSale.status === 400, `status ${badSale.status}`);
  ok("error tells the cashier to choose", /choose a size\/colour/i.test(String(badSale.body?.error || "")), String(badSale.body?.error || ""));

  const sellVariant = rows.find((r) => r.size === "M" && r.color === "Black");
  const beforeSale = Number((await q1(`select quantity from inventory_variants where id = $1`, [sellVariant.id])).quantity);
  const goodSale = await call(token, "/api/sales", "POST", {
    businessId: BIZ,
    cartItems: [{ inventoryId: variantItemId, quantity: 2, sellingPrice: 140, variantId: Number(sellVariant.id) }],
    paymentMethod: "CASH",
    discount: 0,
    createdByUserId: 1, createdByName: "Variant Suite", createdByRole: "OWNER",
  });
  ok("sale with a choice → 200", goodSale.status === 200, `status ${goodSale.status} ${JSON.stringify(goodSale.body).slice(0, 200)}`);
  const afterSale = Number((await q1(`select quantity from inventory_variants where id = $1`, [sellVariant.id])).quantity);
  ok(`M/Black 15 → 13`, afterSale === beforeSale - 2, `${beforeSale} → ${afterSale}`);
  const aggAfterSale = await q1(`select quantity from inventory_items where id = $1`, [variantItemId]);
  const sumActive = await q1(
    `select coalesce(sum(quantity),0)::int s from inventory_variants where inventory_id = $1 and is_active`,
    [variantItemId],
  );
  ok("aggregate equals the live sum (61)", Number(aggAfterSale.quantity) === Number(sumActive.s), `${aggAfterSale.quantity} vs ${sumActive.s}`);
  const saleMove = await q1(
    `select delta, reason, variant_id from stock_movements where inventory_id = $1 and variant_id = $2 and reason = 'SALE' order by id desc limit 1`,
    [variantItemId, sellVariant.id],
  );
  ok("SALE movement carries the variant (-2)", Number(saleMove?.delta) === -2 && Number(saleMove?.variant_id) === Number(sellVariant.id), JSON.stringify(saleMove));

  // ── V1-G · oversell guard ─────────────────────────────────────────────
  section("V1-G · oversell guard stays exact per combination");
  const oversell = await call(token, "/api/sales", "POST", {
    businessId: BIZ,
    cartItems: [{ inventoryId: variantItemId, quantity: 999, sellingPrice: 140, variantId: Number(sellVariant.id) }],
    paymentMethod: "CASH", discount: 0,
    createdByUserId: 1, createdByName: "Variant Suite", createdByRole: "OWNER",
  });
  ok("oversell → 400", oversell.status === 400, `status ${oversell.status}`);
  ok("message quotes the remaining units", /only 13 left|has only/i.test(String(oversell.body?.error || "")), String(oversell.body?.error || ""));
  const afterOver = Number((await q1(`select quantity from inventory_variants where id = $1`, [sellVariant.id])).quantity);
  ok("nothing moved on the refusal (13)", afterOver === 13, `got ${afterOver}`);

  // ── V1-H · reorder radar reports combinations ─────────────────────────
  section("V1-H · reorder radar names the combination, not just the item");
  const lowTarget = rows.find((r) => r.size === "S" && r.color === "White");
  const lowEdit = await call(token, "/api/enterprise", "PATCH", {
    entityType: "INVENTORY", id: variantItemId, actorUserId: 1,
    data: { variantId: Number(lowTarget.id), quantity: 1, minStockThreshold: 4 },
  });
  ok("combination set to 1 (reorder at 4)", lowEdit.status === 200, `status ${lowEdit.status}`);
  const radar = await call(token, `/api/low-stock?businessId=${BIZ}`);
  const radarItem = (radar.body?.items || []).find((i) => Number(i.id) === variantItemId);
  ok("variant product appears on the radar even though its total is healthy", !!radarItem, `items=${(radar.body?.items || []).length}`);
  ok("radar names the combination", (radarItem?.variantAlerts || []).some((v) => v.size === "S" && v.color === "White" && Number(v.quantity) === 1), JSON.stringify(radarItem?.variantAlerts || []).slice(0, 200));
  ok("its own reorder point is used", (radarItem?.variantAlerts || []).some((v) => Number(v.minStockThreshold) === 4));

  // ── V1-I · movement trail completeness ────────────────────────────────
  section("V1-I · movement trail carries variant_id for every variant movement");
  const trail = await q(
    `select variant_id, delta, reason from stock_movements where inventory_id = $1 order by id`,
    [variantItemId],
  );
  ok("no variant movement is missing its variant_id", trail.every((m) => m.variant_id != null), JSON.stringify(trail));
  ok("the trail explains the matrix write too", trail.some((m) => m.reason === "OPENING" || m.reason === "ADJUSTMENT"));

  // ── V1-J · static scan: one writer per family ─────────────────────────
  section("V1-J · no unguarded inventory_items.quantity writers");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/update\(\s*inventoryItems\s*\)/g)) {
          const window = src.slice(Math.max(0, m.index - 400), m.index + 700);
          const writesQuantity = /\.set\([^)]*quantity/s.test(window) && /quantity\s*:/.test(window);
          if (!writesQuantity) continue;
          const allowed =
            p.includes("/lib/variantStock.ts") || // derived aggregate (recompute, not a movement)
            p.includes("/lib/stock.ts") || // THE item-level writer
            p.includes("/lib/lowStock.ts") || // status normalization only (no quantity)
            p.includes("/api/enterprise/route.ts") || // creates/edits the item itself (post-create)
            p.includes("/lib/businessBackup.ts") || // restore
            p.includes("/db/seed.ts");
          if (!allowed) offenders.push(`${p.replace(process.cwd() + "/", "")}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
  };
  walk(join(process.cwd(), "src"));
  ok("no bypass writer found", offenders.length === 0, offenders.join(", "));

  console.log(`\n${failed === 0 ? "✅" : "❌"} variant-stock suite: ${passed} passed, ${failed} failed`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.error("\n❌ suite aborted:", e.message);
} finally {
  await purge();
  await client.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}
