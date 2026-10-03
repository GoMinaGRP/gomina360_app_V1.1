/**
 * Boutique server library — size/colour variant stock on top of the existing
 * Inventory backbone.
 *
 * Design rules (owner directive: reuse the best existing architecture):
 *  • `inventory_items` stays the ONE stock register: its `quantity` is the
 *    live AGGREGATE of the item's active variants, so Sales, Purchases,
 *    Orders, Low Stock, Finance, Reports, Exports and Audit keep working with
 *    zero changes to their data contract.
 *  • `inventory_variants` only answers the sub-line question the register
 *    could not: WHICH size/colour moved. Every deduction/reversal goes
 *    through this module so variant rows and the aggregate can never drift.
 *  • All reads/writes are business-scoped; callers pass the businessId they
 *    already access-checked.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, inventoryVariants } from "@/db/schema";
import { computeStockStatus } from "@/lib/stock";
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

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every active variant row of one business, grouped by inventory item id. */
export async function listVariantsByItem(
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

/**
 * Recompute one item's aggregate quantity/status from its ACTIVE variants.
 * The single place the parent register is written after variant movements, so
 * low-stock alerts, dashboards, reports and the storefront all read reality.
 */
export async function syncItemAggregate(inventoryId: number): Promise<{ quantity: number; status: string } | null> {
  // NOTE (P5): this and the "no active variants" fallback below are the ONLY
  // remaining direct `inventory_items.quantity` writers. They are DERIVED
  // writes — the aggregate is recomputed from the variant rows, not moved — so
  // they deliberately log no `stock_movements` row. Every real movement goes
  // through src/lib/stock.ts. 
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

/**
 * Create / update the variant matrix of one inventory item.
 *  • `replace: true` (default) — the submitted matrix is the full truth:
 *    rows missing from it are deactivated (their stock is folded into the
 *    aggregate if they still hold quantity, so stock is never lost silently).
 *  • `replace: false` — additive upsert (used by quick "add a size").
 * Returns the persisted (active) rows. Throws Error with a friendly message.
 */
export async function setVariantsForItem(opts: {
  businessId: number;
  inventoryId: number;
  variants: unknown;
  replace?: boolean;
  actorName?: string | null;
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

  const existing = await db
    .select()
    .from(inventoryVariants)
    .where(eq(inventoryVariants.inventoryId, inventoryId));
  const byKey = new Map(existing.map((row) => [variantKeyOf(row.size, row.color), row]));

  const keepIds = new Set<number>();
  let order = 0;
  for (const v of matrix) {
    const key = variantKeyOf(v.size, v.color);
    const found = byKey.get(key);
    const qty = r2(Math.max(0, Number(v.quantity) || 0));
    const threshold = r2(Math.max(0, v.minStockThreshold || 0));
    const status = computeStockStatus(qty, threshold);
    if (found) {
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
    } else {
      await db.insert(inventoryVariants).values({
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
        createdByName: opts.actorName || null,
      });
    }
    order++;
  }

  if (opts.replace !== false) {
    const stale = existing.filter((row) => !keepIds.has(Number(row.id)));
    for (const row of stale) {
      if (row.isActive === false) continue;
      if ((Number(row.quantity) || 0) > 0) {
        // Keep the stock: deactivate the row but carry its quantity onto the
        // item's plain stock so nothing is lost. The owner can then re-place
        // it; the aggregate below always reflects reality.
        const [fresh] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
        await db
          .update(inventoryItems)
          .set({ quantity: r2((Number(fresh?.quantity) || 0)) })
          .where(eq(inventoryItems.id, inventoryId));
      }
      await db
        .update(inventoryVariants)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(inventoryVariants.id, Number(row.id)));
    }
  }

  await syncItemAggregate(inventoryId);
  return (await variantsForItem(businessId, inventoryId)).filter((v) => v.isActive !== false);
}

/**
 * Adjust one variant's stock. `delta` may be positive (restock/return) or
 * negative (damage/stock-take); `quantity` sets an absolute value. The parent
 * item's aggregate is recomputed immediately.
 */
export async function adjustVariantStock(opts: {
  businessId: number;
  variantId: number;
  delta?: number | null;
  quantity?: number | null;
  minStockThreshold?: number | null;
  isActive?: boolean | null;
}): Promise<{ ok: boolean; error?: string; variant?: VariantRow; item?: { quantity: number; status: string } | null }> {
  const [row] = await db
    .select()
    .from(inventoryVariants)
    .where(and(eq(inventoryVariants.id, Number(opts.variantId)), eq(inventoryVariants.businessId, Number(opts.businessId))));
  if (!row) return { ok: false, error: "Variant not found in this business." };

  let nextQty = Number(row.quantity) || 0;
  if (opts.quantity != null) nextQty = Number(opts.quantity) || 0;
  else if (opts.delta != null) nextQty = nextQty + (Number(opts.delta) || 0);
  if (nextQty < 0) return { ok: false, error: "Stock cannot go below zero." };

  const threshold =
    opts.minStockThreshold != null
      ? r2(Math.max(0, Number(opts.minStockThreshold) || 0))
      : Number(row.minStockThreshold) || 0;
  const [updated] = await db
    .update(inventoryVariants)
    .set({
      quantity: r2(nextQty),
      minStockThreshold: threshold,
      status: computeStockStatus(r2(nextQty), threshold),
      ...(opts.isActive != null ? { isActive: opts.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(inventoryVariants.id, row.id))
    .returning();
  const item = await syncItemAggregate(Number(row.inventoryId));
  return { ok: true, variant: updated as VariantRow, item };
}

/** Deactivate (soft-delete) one variant; its stock is carried to "unplaced". */
export async function deactivateVariant(businessId: number, variantId: number) {
  return adjustVariantStock({ businessId, variantId, isActive: false });
}

/**
 * Validate a sale/order line's variant choice for one item.
 * Returns the variant row when the item tracks variants and the choice is
 * valid, `null` when the item has no active variants (legacy behaviour), and
 * an `error` string when the client must fix its payload.
 */
export async function resolveVariantForLine(opts: {
  businessId: number;
  inventoryId: number;
  variantId?: number | null;
  quantity: number;
}): Promise<{ variant: VariantRow | null; error?: string }> {
  const rows = (await variantsForItem(Number(opts.businessId), Number(opts.inventoryId))).filter(
    (v) => v.isActive !== false,
  );
  if (rows.length === 0) {
    // No variant matrix on this item: a stray variantId is a forged/stale
    // payload and must never be silently accepted.
    if (opts.variantId) return { variant: null, error: "This product no longer has size/colour options — refresh and try again." };
    return { variant: null };
  }
  if (!opts.variantId) return { variant: null, error: "Choose a size/colour for every variant product." };
  const hit = rows.find((v) => Number(v.id) === Number(opts.variantId));
  if (!hit) return { variant: null, error: "That size/colour is not sold by this product any more." };
  const qty = Number(opts.quantity) || 0;
  if (qty > (Number(hit.quantity) || 0)) {
    return {
      variant: null,
      error: `${hit.size || ""}${hit.size && hit.color ? "/" : ""}${hit.color || ""} has only ${hit.quantity} left.`,
    };
  }
  return { variant: hit };
}

/**
 * Atomic variant deduction: `quantity = quantity - qty WHERE quantity >= qty`.
 * Returns false when the row is missing or short (concurrent sale / order).
 */
export async function deductVariantQty(variantId: number, qty: number): Promise<boolean> {
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
    returning id
  `);
  const changed = ((res as any)?.rows ?? res) as any[];
  return Array.isArray(changed) && changed.length > 0;
}

/** Give variant stock back (cancelled order, return, correction). */
export async function restoreVariantQty(variantId: number, qty: number): Promise<boolean> {
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
    returning id
  `);
  const changed = ((res as any)?.rows ?? res) as any[];
  return Array.isArray(changed) && changed.length > 0;
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

/**
 * Public storefront projection of one item's variant matrix — the data the
 * Customer Order Page needs to render available sizes/colours and disable the
 * combinations that are out of stock.
 */
export function storefrontVariants(rows: VariantRow[]) {
  const active = rows.filter((v) => v.isActive !== false);
  const sizes: { value: string; system: string | null; available: number; inStock: boolean }[] = [];
  const colors: { value: string; available: number; inStock: boolean }[] = [];
  const variants = active.map((v) => ({
    id: Number(v.id),
    size: v.size || null,
    color: v.color || null,
    sizeSystem: v.sizeSystem || null,
    sku: v.sku || null,
    available: Math.max(0, Math.floor(Number(v.quantity) || 0)),
    inStock: (Number(v.quantity) || 0) > 0,
  }));
  for (const v of variants) {
    if (v.size) {
      const hit = sizes.find((s) => s.value === v.size);
      if (hit) {
        hit.available += v.available;
        hit.inStock = hit.inStock || v.inStock;
      } else {
        sizes.push({ value: v.size, system: v.sizeSystem, available: v.available, inStock: v.inStock });
      }
    }
    if (v.color) {
      const hit = colors.find((c) => c.value === v.color);
      if (hit) {
        hit.available += v.available;
        hit.inStock = hit.inStock || v.inStock;
      } else {
        colors.push({ value: v.color, available: v.available, inStock: v.inStock });
      }
    }
  }
  return {
    hasVariants: variants.length > 0,
    sizes,
    colors,
    variants,
    totalAvailable: variants.reduce((s, v) => s + v.available, 0),
  };
}
