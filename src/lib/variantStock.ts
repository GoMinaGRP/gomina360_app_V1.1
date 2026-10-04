/**
 * Variant stock library — the COMPLETE size/colour/option stock family.
 *
 * `inventory_items` stays the ONE stock register: its `quantity` is the live
 * AGGREGATE of the item's active variant rows, so Sales, Purchases, Orders,
 * Low Stock, Finance, Reports, Exports and Audit keep working with zero changes
 * to their data contract. `inventory_variants` answers the sub-line question
 * the register could not: WHICH combination moved.
 *
 * ONE module owns this family (P6 — one writer per data family):
 *   • structure + quantities  → setVariantsForItem / applyVariantDelta
 *   • atomic sale deduction   → deductVariantQty / restoreVariantQty
 *   • the derived aggregate   → syncItemAggregate (the only derived writer)
 *   • reorder reads           → lowStockVariantsForBusiness
 *
 * `src/lib/stock.ts` refuses item-level writes on a variant product and routes
 * them here; `src/lib/boutique.ts` re-exports everything for backwards
 * compatibility, so existing importers keep working unchanged.
 *
 * Variant rows are never priced; they resolve to the parent's price unless a
 * future phase adds per-combination pricing.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { businesses, inventoryItems, inventoryVariants } from "@/db/schema";
import { computeStockStatus } from "@/lib/stockStatus";
import { logStockMovement } from "@/lib/stockMovements";
import {
  MAX_VARIANTS_PER_ITEM,
  cleanVariantValue,
  normalizeVariantMatrix,
  variantKeyOf,
  type VariantStockRow,
} from "@/lib/boutiqueSizes";

export type VariantRow = {
  id: number;
  businessId: number;
  inventoryId: number;
  size: string;
  color: string;
  sizeSystem: string | null;
  sku: string | null;
  quantity: number;
  minStockThreshold: number;
  status: string | null;
  isActive: boolean;
  sortOrder: number | null;
};

export interface StockActorLike {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

/** Optional movement-trail metadata threaded through the variant writers. */
export interface VariantTrail {
  reason?: string;
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  branchCode?: string | null;
  actor?: StockActorLike | null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** All variant rows (including inactive) for one item, business-scoped. */
export async function variantsForItem(businessId: number, inventoryId: number): Promise<VariantRow[]> {
  const rows = await db
    .select()
    .from(inventoryVariants)
    .where(
      and(
        eq(inventoryVariants.businessId, Number(businessId)),
        eq(inventoryVariants.inventoryId, Number(inventoryId)),
      ),
    )
    .orderBy(asc(inventoryVariants.sortOrder), asc(inventoryVariants.id));
  return rows as VariantRow[];
}

/** Active variant rows for several items at once, grouped by item id. */
export async function activeVariantsByItem(
  businessId: number,
  inventoryIds?: number[],
): Promise<Map<number, VariantRow[]>> {
  const ids = (inventoryIds || []).map(Number).filter(Number.isFinite);
  const where =
    ids.length > 0
      ? and(eq(inventoryVariants.businessId, Number(businessId)), inArray(inventoryVariants.inventoryId, ids))
      : eq(inventoryVariants.businessId, Number(businessId));
  const rows = await db
    .select()
    .from(inventoryVariants)
    .where(where)
    .orderBy(asc(inventoryVariants.sortOrder), asc(inventoryVariants.id));
  const map = new Map<number, VariantRow[]>();
  for (const row of rows as VariantRow[]) {
    if (row.isActive === false) continue;
    const list = map.get(Number(row.inventoryId)) || [];
    list.push({ ...row, quantity: Number(row.quantity) || 0 });
    map.set(Number(row.inventoryId), list);
  }
  return map;
}

/** How many active rows an item has (cheap guard for callers). */
export async function countActiveVariants(businessId: number, inventoryId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryVariants)
    .where(
      and(
        eq(inventoryVariants.businessId, Number(businessId)),
        eq(inventoryVariants.inventoryId, Number(inventoryId)),
        eq(inventoryVariants.isActive, true),
      ),
    );
  return Number(row?.n) || 0;
}

/**
 * Recompute one item's aggregate quantity/status from its ACTIVE variants.
 * The single place the parent register is written after variant movements, so
 * low-stock alerts, dashboards, reports and the storefront all read reality.
 *
 * This is a DERIVED write — the aggregate is recomputed from the rows, not
 * moved — so it deliberately logs no `stock_movements` row.
 */
export async function syncItemAggregate(inventoryId: number): Promise<{ quantity: number; status: string } | null> {
  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(inventoryId)));
  if (!item) return null;
  const rows = await db
    .select()
    .from(inventoryVariants)
    .where(and(eq(inventoryVariants.inventoryId, Number(inventoryId)), eq(inventoryVariants.isActive, true)));
  if (rows.length === 0) {
    // No active variants left → fall back to plain item stock; never silently
    // zero a product whose variants were all removed.
    await db
      .update(inventoryItems)
      .set({ tracksVariants: false })
      .where(eq(inventoryItems.id, Number(inventoryId)));
    return { quantity: Number(item.quantity) || 0, status: item.status || "IN_STOCK" };
  }
  const quantity = r2(rows.reduce((s, v) => s + (Number(v.quantity) || 0), 0));
  const status = computeStockStatus(quantity, Number(item.minStockThreshold) || 0);
  await db
    .update(inventoryItems)
    .set({ quantity, status, tracksVariants: true })
    .where(eq(inventoryItems.id, Number(inventoryId)));
  return { quantity, status };
}

/** Next free variant SKU for a business, derived from the parent SKU. */
async function nextVariantSku(businessId: number, baseSku: string, size: string, color: string): Promise<string> {
  const tail = [cleanVariantValue(size, 10), cleanVariantValue(color, 10)]
    .filter(Boolean)
    .join("-")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const root = String(baseSku || "SKU")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const existing = await db
    .select({ sku: inventoryVariants.sku })
    .from(inventoryVariants)
    .where(eq(inventoryVariants.businessId, Number(businessId)));
  const taken = new Set(existing.map((r) => String(r.sku || "").toUpperCase()).filter(Boolean));
  let candidate = tail ? `${root}-${tail}` : root;
  let n = 2;
  while (taken.has(candidate.toUpperCase())) candidate = `${(tail ? `${root}-${tail}` : root).slice(0, 52)}-${n++}`;
  return candidate;
}

/** Human label for a combination, used in messages and the movement trail. */
export function variantLabelOf(size?: string | null, color?: string | null): string {
  return [size ? `Size ${size}` : null, color || null].filter(Boolean).join(" · ") || "Standard";
}

/**
 * Create / update the variant matrix of one inventory item.
 *  • `replace: true` (default) — the submitted matrix is the full truth:
 *    rows missing from it are deactivated (their stock leaves the sellable
 *    register and the movement trail records it, so nothing disappears
 *    unexplained).
 *  • `replace: false` — additive upsert (used by quick "add a size").
 * Every quantity change is logged to `stock_movements` with its `variantId`.
 * Returns the persisted (active) rows. Throws Error with a friendly message.
 */
export async function setVariantsForItem(opts: {
  businessId: number;
  inventoryId: number;
  variants: unknown;
  replace?: boolean;
  actorName?: string | null;
  /** Trail metadata — registration passes OPENING, edits pass ADJUSTMENT. */
  reason?: string | null;
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  actor?: StockActorLike | null;
}): Promise<VariantRow[]> {
  const businessId = Number(opts.businessId);
  const inventoryId = Number(opts.inventoryId);
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, inventoryId), eq(inventoryItems.businessId, businessId)));
  if (!item) throw new Error("Product not found in this business.");

  const matrix: VariantStockRow[] = normalizeVariantMatrix(opts.variants);
  if (matrix.length === 0) throw new Error("Add at least one size or colour variant.");
  if (matrix.length > MAX_VARIANTS_PER_ITEM) throw new Error(`A product can have at most ${MAX_VARIANTS_PER_ITEM} variants.`);

  const [existing, [biz]] = await Promise.all([
    db.select().from(inventoryVariants).where(eq(inventoryVariants.inventoryId, inventoryId)),
    db.select({ code: businesses.code }).from(businesses).where(eq(businesses.id, businessId)),
  ]);
  const byKey = new Map(existing.map((row) => [variantKeyOf(row.size, row.color), row]));

  const reason = opts.reason || "ADJUSTMENT";
  const actor = opts.actor || (opts.actorName ? { name: opts.actorName } : null);
  const movement = (variantId: number, delta: number, quantityAfter: number, note: string) =>
    logStockMovement({
      businessId,
      branchCode: biz?.code || (item as any).branchCode || null,
      inventoryId,
      sku: item.sku || null,
      itemName: item.name || null,
      delta,
      quantityAfter,
      reason,
      refType: opts.refType || "VARIANT_MATRIX",
      refId: opts.refId ?? null,
      note: opts.note ? `${opts.note} — ${note}` : note,
      variantId,
      actor,
    });

  const keepIds = new Set<number>();
  let order = 0;
  for (const v of matrix) {
    const key = variantKeyOf(v.size, v.color);
    const found = byKey.get(key);
    const qty = r2(Math.max(0, Number(v.quantity) || 0));
    const threshold = r2(Math.max(0, v.minStockThreshold || 0));
    const status = computeStockStatus(qty, threshold);
    const label = variantLabelOf(v.size, v.color);
    if (found) {
      const before = Number(found.quantity) || 0;
      keepIds.add(Number(found.id));
      await db
        .update(inventoryVariants)
        .set({
          size: v.size,
          color: v.color,
          sizeSystem: v.sizeSystem || found.sizeSystem || "CUSTOM",
          sku: v.sku ? String(v.sku).toUpperCase().slice(0, 60) : found.sku,
          quantity: qty,
          minStockThreshold: threshold,
          status,
          isActive: true,
          sortOrder: found.sortOrder ?? order,
          updatedAt: new Date(),
        })
        .where(eq(inventoryVariants.id, Number(found.id)));
      if (r2(before) !== qty) {
        await movement(Number(found.id), r2(qty - before), qty, `${label}: ${before} → ${qty}`);
      }
    } else {
      const [inserted] = await db
        .insert(inventoryVariants)
        .values({
          businessId,
          inventoryId,
          size: v.size,
          color: v.color,
          sizeSystem: v.sizeSystem || "CUSTOM",
          sku: v.sku || (await nextVariantSku(businessId, item.sku, v.size, v.color)),
          quantity: qty,
          minStockThreshold: threshold,
          status,
          isActive: true,
          sortOrder: order,
          createdByName: opts.actorName || opts.actor?.name || null,
        })
        .returning();
      if (qty > 0) await movement(Number(inserted.id), qty, qty, `${label}: new combination, ${qty} in`);
    }
    order++;
  }

  if (opts.replace !== false) {
    const stale = existing.filter((row) => !keepIds.has(Number(row.id)));
    for (const row of stale) {
      if (row.isActive === false) continue;
      const held = Number(row.quantity) || 0;
      await db
        .update(inventoryVariants)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(inventoryVariants.id, Number(row.id)));
      if (held > 0) {
        // The combination is no longer sold: its units leave the sellable
        // register. The movement row explains where the drop came from.
        await movement(
          Number(row.id),
          -held,
          held,
          `${variantLabelOf(row.size, row.color)}: combination removed from sale — ${held} set aside`,
        );
      }
    }
  }

  const aggregate = await syncItemAggregate(inventoryId);
  // Keep the trail's "quantityAfter" for the item consistent with the derived
  // aggregate on the last row we touched (informational only).
  void aggregate;
  return (await variantsForItem(businessId, inventoryId)).filter((v) => v.isActive !== false);
}

/**
 * THE variant movement writer (non-sale flows): restock, stock-take, damage,
 * module receipts/deliveries. Applies a signed delta or an absolute quantity
 * with optional threshold / active changes, re-derives the aggregate, and logs
 * one movement row carrying the `variantId`.
 */
export async function applyVariantDelta(opts: {
  businessId: number;
  variantId: number;
  delta?: number | null;
  quantity?: number | null;
  minStockThreshold?: number | null;
  isActive?: boolean | null;
  /** Default true — never let a combination go negative. */
  clampAtZero?: boolean;
  /** Default true — recompute the parent aggregate after the write. */
  sync?: boolean;
  trail?: VariantTrail | null;
}): Promise<{ ok: boolean; error?: string; variant?: VariantRow; item?: { quantity: number; status: string } | null; applied?: number }> {
  const businessId = Number(opts.businessId);
  const [row] = await db
    .select()
    .from(inventoryVariants)
    .where(and(eq(inventoryVariants.id, Number(opts.variantId)), eq(inventoryVariants.businessId, businessId)));
  if (!row) return { ok: false, error: "That size/colour is not on this product any more." };

  const current = Number(row.quantity) || 0;
  let target =
    opts.quantity != null ? Number(opts.quantity) || 0 : current + (Number(opts.delta) || 0);
  const clamp = opts.clampAtZero !== false;
  if (target < 0) {
    if (clamp) target = 0;
    else return { ok: false, error: "Stock cannot go below zero." };
  }
  target = r2(target);
  const threshold =
    opts.minStockThreshold != null
      ? r2(Math.max(0, Number(opts.minStockThreshold) || 0))
      : Number(row.minStockThreshold) || 0;
  const applied = r2(target - current);

  const [updated] = await db
    .update(inventoryVariants)
    .set({
      quantity: target,
      minStockThreshold: threshold,
      status: computeStockStatus(target, threshold),
      ...(opts.isActive != null ? { isActive: opts.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(inventoryVariants.id, row.id))
    .returning();

  const item = opts.sync === false ? null : await syncItemAggregate(Number(row.inventoryId));

  if (applied !== 0) {
    const [item2] = await db
      .select({ sku: inventoryItems.sku, name: inventoryItems.name, branchCode: inventoryItems.branchCode })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, Number(row.inventoryId)));
    await logStockMovement({
      businessId,
      branchCode: opts.trail?.branchCode || item2?.branchCode || null,
      inventoryId: Number(row.inventoryId),
      sku: item2?.sku || null,
      itemName: item2?.name || null,
      delta: applied,
      quantityAfter: target,
      reason: opts.trail?.reason || "ADJUSTMENT",
      refType: opts.trail?.refType || "VARIANT_ADJUST",
      refId: opts.trail?.refId ?? null,
      note: opts.trail?.note || `${variantLabelOf(row.size, row.color)}: ${current} → ${target}`,
      variantId: Number(row.id),
      actor: opts.trail?.actor || null,
    });
  }

  return { ok: true, variant: updated as VariantRow, item, applied };
}

/**
 * Adjust one variant's stock. `delta` may be positive (restock/return) or
 * negative (damage/stock-take); `quantity` sets an absolute value. The parent
 * item's aggregate is recomputed immediately and the change is logged.
 */
export async function adjustVariantStock(opts: {
  businessId: number;
  variantId: number;
  delta?: number | null;
  quantity?: number | null;
  minStockThreshold?: number | null;
  isActive?: boolean | null;
  reason?: string | null;
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  branchCode?: string | null;
  actor?: StockActorLike | null;
}): Promise<{ ok: boolean; error?: string; variant?: VariantRow; item?: { quantity: number; status: string } | null }> {
  const res = await applyVariantDelta({
    businessId: opts.businessId,
    variantId: opts.variantId,
    delta: opts.quantity != null ? null : opts.delta ?? null,
    quantity: opts.quantity ?? null,
    minStockThreshold: opts.minStockThreshold ?? null,
    isActive: opts.isActive ?? null,
    clampAtZero: false, // keep the explicit "Stock cannot go below zero" error
    trail: {
      reason: opts.reason || "RESTOCK",
      refType: opts.refType || "VARIANT_ADJUST",
      refId: opts.refId ?? null,
      note: opts.note || null,
      branchCode: opts.branchCode || null,
      actor: opts.actor || null,
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, variant: res.variant, item: res.item };
}

/**
 * Deactivate (soft-delete) one combination. Its units leave the sellable
 * register (aggregate re-derived) and the trail records the set-aside, so the
 * drop is explained rather than silent.
 */
export async function deactivateVariant(businessId: number, variantId: number, trail?: VariantTrail | null) {
  const [row] = await db
    .select()
    .from(inventoryVariants)
    .where(and(eq(inventoryVariants.id, Number(variantId)), eq(inventoryVariants.businessId, Number(businessId))));
  const held = Number(row?.quantity) || 0;
  const res = await adjustVariantStock({
    businessId,
    variantId,
    isActive: false,
    reason: trail?.reason || "ADJUSTMENT",
    refType: trail?.refType || "VARIANT_DEACTIVATE",
    note:
      trail?.note ||
      (held > 0
        ? `${variantLabelOf(row?.size, row?.color)} removed from sale — ${held} set aside`
        : `${variantLabelOf(row?.size, row?.color)} removed from sale`),
    actor: trail?.actor || null,
    branchCode: trail?.branchCode || null,
  });
  return res;
}

/**
 * Atomic variant deduction: `quantity = quantity - qty WHERE quantity >= qty`.
 * Returns false when the row is missing or short (concurrent sale / order).
 * Pass `trail` to append the sale/order movement row (with its `variantId`).
 */
export async function deductVariantQty(
  variantId: number,
  qty: number,
  trail?: (VariantTrail & { businessId?: number; inventoryId?: number }) | null,
): Promise<boolean> {
  const n = Number(qty) || 0;
  if (n <= 0) return true;
  const res = await db.execute(sql`
    update inventory_variants
       set quantity = quantity - ${n},
           status = case when quantity - ${n} <= 0 then 'OUT_OF_STOCK'
                         when quantity - ${n} <= min_stock_threshold and min_stock_threshold > 0 then 'LOW_STOCK'
                         else 'IN_STOCK' end,
           updated_at = now()
     where id = ${Number(variantId)}
       and is_active = true
       and quantity >= ${n}
    returning id, quantity, size, color, business_id, inventory_id
  `);
  const changed = ((res as any)?.rows ?? res) as any[];
  const ok = Array.isArray(changed) && changed.length > 0;
  if (ok && trail?.businessId) {
    const row = changed[0] || {};
    const inventoryId = Number(trail.inventoryId || row.inventory_id || 0);
    const [item] = inventoryId
      ? await db
          .select({ sku: inventoryItems.sku, name: inventoryItems.name, branchCode: inventoryItems.branchCode })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, inventoryId))
      : [];
    await logStockMovement({
      businessId: Number(trail.businessId),
      branchCode: trail.branchCode || item?.branchCode || null,
      inventoryId,
      sku: item?.sku || null,
      itemName: item?.name || null,
      delta: -n,
      quantityAfter: Number(row.quantity) || 0,
      reason: trail.reason || "SALE",
      refType: trail.refType || "VARIANT_SALE",
      refId: trail.refId ?? null,
      note: trail.note || variantLabelOf(row.size, row.color),
      variantId: Number(variantId),
      actor: trail.actor || null,
    });
  }
  return ok;
}

/**
 * Give variant stock back (cancelled order, return, correction). Pass `trail`
 * to append the RESTORE movement row (with its `variantId`).
 */
export async function restoreVariantQty(
  variantId: number,
  qty: number,
  trail?: (VariantTrail & { businessId?: number; inventoryId?: number }) | null,
): Promise<boolean> {
  const n = Number(qty) || 0;
  if (n <= 0) return true;
  const res = await db.execute(sql`
    update inventory_variants
       set quantity = quantity + ${n},
           status = case when quantity + ${n} <= 0 then 'OUT_OF_STOCK'
                         when quantity + ${n} <= min_stock_threshold and min_stock_threshold > 0 then 'LOW_STOCK'
                         else 'IN_STOCK' end,
           updated_at = now()
     where id = ${Number(variantId)}
    returning id, quantity, size, color, business_id, inventory_id
  `);
  const changed = ((res as any)?.rows ?? res) as any[];
  const ok = Array.isArray(changed) && changed.length > 0;
  if (ok && trail?.businessId) {
    const row = changed[0] || {};
    const inventoryId = Number(trail.inventoryId || row.inventory_id || 0);
    const [item] = inventoryId
      ? await db
          .select({ sku: inventoryItems.sku, name: inventoryItems.name, branchCode: inventoryItems.branchCode })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, inventoryId))
      : [];
    await logStockMovement({
      businessId: Number(trail.businessId),
      branchCode: trail.branchCode || item?.branchCode || null,
      inventoryId,
      sku: item?.sku || null,
      itemName: item?.name || null,
      delta: n,
      quantityAfter: Number(row.quantity) || 0,
      reason: trail.reason || "RESTORE",
      refType: trail.refType || "VARIANT_RESTORE",
      refId: trail.refId ?? null,
      note: trail.note || variantLabelOf(row.size, row.color),
      variantId: Number(variantId),
      actor: trail.actor || null,
    });
  }
  return ok;
}

/** Variant rows at/below their reorder point for one business (OUT first). */
export async function lowStockVariantsForBusiness(businessId: number) {
  const rows = await db
    .select({
      id: inventoryVariants.id,
      inventoryId: inventoryVariants.inventoryId,
      size: inventoryVariants.size,
      color: inventoryVariants.color,
      quantity: inventoryVariants.quantity,
      minStockThreshold: inventoryVariants.minStockThreshold,
      sku: inventoryVariants.sku,
      itemName: inventoryItems.name,
      unit: inventoryItems.unit,
    })
    .from(inventoryVariants)
    .leftJoin(inventoryItems, eq(inventoryItems.id, inventoryVariants.inventoryId))
    .where(
      and(
        eq(inventoryVariants.businessId, Number(businessId)),
        eq(inventoryVariants.isActive, true),
        sql`((${inventoryVariants.quantity} <= ${inventoryVariants.minStockThreshold} and ${inventoryVariants.minStockThreshold} > 0) or ${inventoryVariants.quantity} <= 0)`,
      ),
    );
  return rows
    .map((r) => ({
      ...r,
      quantity: Number(r.quantity) || 0,
      severity: (Number(r.quantity) || 0) <= 0 ? ("OUT" as const) : ("LOW" as const),
    }))
    .sort((a, b) => (a.severity === b.severity ? a.quantity - b.quantity : a.severity === "OUT" ? -1 : 1));
}
