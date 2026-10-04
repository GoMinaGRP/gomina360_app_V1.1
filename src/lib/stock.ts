import { db } from "@/db";
import { inventoryItems, stockMovements } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { normalizeInventoryCategory, deriveInventorySubcategory } from "@/lib/inventoryCategories";
import { computeStockStatus } from "@/lib/stockStatus";
import { logStockMovement } from "@/lib/stockMovements";
import { applyVariantDelta, variantLabelOf, variantsForItem } from "@/lib/variantStock";

/**
 * Shared stock helpers — every module (production, harvest, purchases, sales)
 * funnels quantity changes through these so inventory, dashboards, alerts and
 * reports always stay in sync.
 *
 * TWO writers, ONE per data family (P6):
 *   • NON-VARIANT items — this file owns `inventory_items.quantity`.
 *   • VARIANT items (tracksVariants) — the item quantity is a DERIVED
 *     aggregate; the size/colour rows in `src/lib/variantStock.ts` are the
 *     truth. A write here without a `variantId` is REFUSED with a plain
 *     message instead of silently overwriting (and later being reverted by)
 *     the aggregate.
 */

// The shared status rule lives in its own module so both writers can use it;
// re-exported here for the many callers that import it from "@/lib/stock".
export { computeStockStatus } from "@/lib/stockStatus";

export const STOCK_REASONS = [
  "PRODUCTION",
  "PURCHASE",
  "SALE",
  "CONSUMPTION",
  "WASTE",
  "HARVEST",
  "RESTOCK",
  "ADJUSTMENT",
  "RESTORE",
  "OPENING",
  "RETURN",
] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export interface StockActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

export interface ApplyStockChangeOptions {
  businessId: number;
  /** Target item: pass `inventoryId`, or `sku`/`name` to resolve within the business. */
  inventoryId?: number | null;
  sku?: string | null;
  name?: string | null;
  /** Signed change: positive = into stock, negative = out of stock. */
  delta: number;
  reason: StockReason | string;
  branchCode?: string | null;
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  /**
   * Variant choice for a tracked item. Required for any movement on a product
   * that has a size/colour matrix — without it the write is refused.
   */
  variantId?: number | null;
  actor?: StockActor;
  /** Never let the quantity fall below zero (default true, the pre-P5 behaviour). */
  clampAtZero?: boolean;
  /** Optional field updates applied in the same write (purchase prices, expiry). */
  setCostPriceGhs?: number | null;
  setSellingPriceGhs?: number | null;
  setExpiryDate?: string | null;
  /** Skip the movement row (derived writes only — e.g. variant aggregate sync). */
  log?: boolean;
}

export interface AppliedStockChange {
  item: any | null;
  deducted: number;
  added: number;
  quantityAfter: number;
  /** True when nothing moved because the target was wrong (e.g. variant product without a choice). */
  refused?: boolean;
  /** Plain-language reason for a refusal (shown to the user by the caller). */
  error?: string;
  /** The variant row that moved, when the item tracks variants. */
  variantId?: number | null;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Resolve one inventory row inside a business by id, else SKU, else name.
 * Tenant-scoped: a caller can never reach another unit's item.
 */
export async function resolveInventoryItem(opts: {
  businessId: number;
  inventoryId?: number | null;
  sku?: string | null;
  name?: string | null;
}) {
  const businessId = Number(opts.businessId);
  if (opts.inventoryId) {
    const [found] = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, Number(opts.inventoryId)), eq(inventoryItems.businessId, businessId)));
    if (found) return found;
  }
  if (opts.sku || opts.name) {
    const items = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
    return (
      (opts.sku ? items.find((i) => (i.sku || "").toUpperCase() === String(opts.sku).toUpperCase()) : null) ||
      (opts.name ? items.find((i) => (i.name || "").toLowerCase() === String(opts.name).toLowerCase()) : null) ||
      null
    );
  }
  return null;
}

/**
 * THE stock writer. Every real quantity change in the product goes through
 * here: it applies the signed delta, recomputes the IN_STOCK / LOW_STOCK /
 * OUT_OF_STOCK status from the shared rule, and appends the `stock_movements`
 * audit row (who, why, from which workflow). Modules keep their own business
 * rules; they no longer re-implement read-modify-write + status maths.
 */
export async function applyStockChange(opts: ApplyStockChangeOptions): Promise<AppliedStockChange> {
  const businessId = Number(opts.businessId);
  const delta = Number(opts.delta) || 0;
  const empty: AppliedStockChange = { item: null, deducted: 0, added: 0, quantityAfter: 0 };
  if (!businessId) return empty;

  const item = await resolveInventoryItem({
    businessId,
    inventoryId: opts.inventoryId,
    sku: opts.sku,
    name: opts.name,
  });
  if (!item) return empty;

  // ── Variant items: the size/colour rows are the truth ────────────────
  // `inventory_items.quantity` is only ever a DERIVED aggregate of those rows,
  // so an item-level write here would be silently reverted by the next
  // syncItemAggregate (a lost deduction = oversell). Route the movement to the
  // exact combination, or refuse with a plain message.
  if ((item as any).tracksVariants === true) {
    return applyVariantStockChange(item, businessId, delta, opts);
  }

  const current = Number(item.quantity) || 0;
  const clamp = opts.clampAtZero !== false;
  let next = r4(current + delta);
  if (clamp && next < 0) next = 0;
  const deducted = delta < 0 ? r4(Math.min(Math.abs(delta), Math.abs(current))) : 0;
  const added = delta > 0 ? delta : 0;

  const set: any = {
    quantity: next,
    status: computeStockStatus(next, Number(item.minStockThreshold) || 0),
  };
  if (opts.setCostPriceGhs != null && Number(opts.setCostPriceGhs) > 0) set.costPriceGhs = Number(opts.setCostPriceGhs);
  if (opts.setSellingPriceGhs != null && Number(opts.setSellingPriceGhs) > 0)
    set.sellingPriceGhs = Number(opts.setSellingPriceGhs);
  if (opts.setExpiryDate) set.expiryDate = opts.setExpiryDate;

  const [updated] = await db
    .update(inventoryItems)
    .set(set)
    .where(eq(inventoryItems.id, item.id))
    .returning();

  if (opts.log !== false && delta !== 0) {
    await logStockMovement({
      businessId,
      branchCode: opts.branchCode || (item as any).branchCode || null,
      inventoryId: Number(item.id),
      sku: item.sku || null,
      itemName: item.name || null,
      delta,
      quantityAfter: next,
      reason: String(opts.reason || "ADJUSTMENT"),
      refType: opts.refType || null,
      refId: opts.refId != null ? Number(opts.refId) : null,
      note: opts.note || null,
      variantId: opts.variantId != null ? Number(opts.variantId) : null,
      actor: opts.actor || null,
    });
  }

  return { item: updated || item, deducted, added, quantityAfter: next };
}

/**
 * Read the movement trail for an item (newest first) — powers "why did this
 * change?" views and the phase-5 verification suite.
 */
export async function stockMovementsFor(opts: { businessId: number; inventoryId: number; limit?: number }) {
  return db
    .select()
    .from(stockMovements)
    .where(
      and(eq(stockMovements.businessId, Number(opts.businessId)), eq(stockMovements.inventoryId, Number(opts.inventoryId)))
    )
    .orderBy(desc(stockMovements.id))
    .limit(Math.min(Number(opts.limit) || 50, 500));
}

/**
 * Ensure an inventory item exists for the given business. Matches by SKU
 * (case-insensitive) or exact name within the business; creates the item when
 * missing so produced goods instantly become sellable products.
 */
export async function ensureInventoryItem(opts: {
  businessId: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  /** Optional specific wording kept alongside the standard umbrella category. */
  subcategory?: string | null;
  costPriceGhs?: number;
  sellingPriceGhs?: number;
  minStockThreshold?: number;
}) {
  const items = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.businessId, opts.businessId));

  const match =
    items.find((i) => (i.sku || "").toUpperCase() === opts.sku.toUpperCase()) ||
    items.find((i) => (i.name || "").toLowerCase() === opts.name.toLowerCase());

  if (match) return match;

  const threshold = opts.minStockThreshold ?? 10;
  const [created] = await db
    .insert(inventoryItems)
    .values({
      name: opts.name,
      sku: opts.sku,
      businessId: opts.businessId,
      // Every module's stock-in lands in the shared standardized taxonomy so the
      // customer marketplace groups similar products from all businesses.
      category: normalizeInventoryCategory(opts.category),
      subcategory: deriveInventorySubcategory(opts.category, opts.subcategory),
      quantity: 0,
      unit: opts.unit,
      costPriceGhs: opts.costPriceGhs ?? 0,
      sellingPriceGhs: opts.sellingPriceGhs ?? 0,
      minStockThreshold: threshold,
      status: computeStockStatus(0, threshold),
    })
    .returning();
  return created;
}

/**
 * Add produced / purchased goods into stock. Creates the item if it does not
 * exist, tops up the quantity, refreshes prices when provided, and recomputes
 * the IN_STOCK / LOW_STOCK / OUT_OF_STOCK status that drives the alerts.
 */
export async function stockIn(opts: {
  businessId: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  costPriceGhs?: number;
  sellingPriceGhs?: number;
  minStockThreshold?: number;
  reason?: StockReason | string;
  refType?: string | null;
  refId?: number | null;
  branchCode?: string | null;
  note?: string | null;
  actor?: StockActor;
  /** Exact combination for a variant product (required for those items). */
  variantId?: number | null;
}) {
  const qty = Number(opts.quantity) || 0;
  if (qty <= 0) return null;
  const item = await ensureInventoryItem({ ...opts });
  const applied = await applyStockChange({
    businessId: opts.businessId,
    inventoryId: item.id,
    delta: qty,
    reason: opts.reason || "PURCHASE",
    refType: opts.refType,
    refId: opts.refId,
    branchCode: opts.branchCode,
    note: opts.note,
    actor: opts.actor,
    variantId: opts.variantId ?? null,
    setCostPriceGhs: opts.costPriceGhs,
    setSellingPriceGhs: opts.sellingPriceGhs,
  });
  if (applied.refused) {
    // Loud but non-fatal: the caller's business action completes, the stock
    // move does not. The message tells the user exactly what to do instead.
    console.warn(`[stock] stock-in refused for "${item.name}": ${applied.error}`);
    return null;
  }
  return applied.item;
}

/**
 * Deduct goods from stock (farm-gate sales, consumption, waste). Never fails
 * the caller: clamps at zero and reports what was actually deducted.
 */
export async function stockOut(opts: {
  businessId: number;
  inventoryId?: number | null;
  sku?: string;
  name?: string;
  quantity: number;
  reason?: StockReason | string;
  refType?: string | null;
  refId?: number | null;
  branchCode?: string | null;
  note?: string | null;
  actor?: StockActor;
  /** Exact combination for a variant product (required for those items). */
  variantId?: number | null;
}) {
  const qty = Number(opts.quantity) || 0;
  if (qty <= 0) return { deducted: 0, item: null as any, refused: false, error: undefined };
  const applied = await applyStockChange({
    businessId: opts.businessId,
    inventoryId: opts.inventoryId,
    sku: opts.sku,
    name: opts.name,
    delta: -qty,
    reason: opts.reason || "CONSUMPTION",
    refType: opts.refType,
    refId: opts.refId,
    branchCode: opts.branchCode,
    note: opts.note,
    actor: opts.actor,
    variantId: opts.variantId ?? null,
  });
  return { deducted: applied.deducted, item: applied.item, refused: applied.refused, error: applied.error };
}

/**
 * Route one movement on a VARIANT product to its exact combination.
 *
 * Resolution order:
 *   1. an explicit `variantId` (the picker's choice);
 *   2. a `sku` that matches a variant row's SKU (module flows that key on SKU);
 *   otherwise the write is REFUSED — a variant product can never be moved by
 *   its aggregate.
 *
 * Clamping mirrors the item-level writer, and one movement row with the
 * `variantId` is appended, so the trail explains both the combination and the
 * item aggregate.
 */
async function applyVariantStockChange(
  item: any,
  businessId: number,
  delta: number,
  opts: ApplyStockChangeOptions,
): Promise<AppliedStockChange> {
  const empty: AppliedStockChange = { item, deducted: 0, added: 0, quantityAfter: 0 };
  const rows = await variantsForItem(businessId, Number(item.id));
  const active = rows.filter((v) => v.isActive !== false);

  let variantId: number | null = null;
  if (opts.variantId != null && Number(opts.variantId) > 0) {
    variantId = Number(opts.variantId);
  } else if (opts.sku) {
    const bySku = active.find((v) => String(v.sku || "").toUpperCase() === String(opts.sku).toUpperCase());
    if (bySku) variantId = Number(bySku.id);
  }

  if (variantId == null) {
    return {
      ...empty,
      quantityAfter: Number(item.quantity) || 0,
      refused: true,
      error: `"${item.name}" is stocked by ${active.length > 0 ? "size/colour" : "options"} — choose the combination to move.`,
    };
  }

  const target = active.find((v) => Number(v.id) === variantId);
  if (!target) {
    return {
      ...empty,
      quantityAfter: Number(item.quantity) || 0,
      refused: true,
      error: "That size/colour is not sold by this product any more.",
    };
  }

  const res = await applyVariantDelta({
    businessId,
    variantId,
    delta,
    clampAtZero: opts.clampAtZero !== false,
    trail: {
      reason: String(opts.reason || "ADJUSTMENT"),
      refType: opts.refType || "VARIANT_ADJUST",
      refId: opts.refId ?? null,
      note: opts.note || null,
      branchCode: opts.branchCode || (item as any).branchCode || null,
      actor: opts.actor || null,
    },
  });
  if (!res.ok || !res.variant) {
    return {
      ...empty,
      quantityAfter: Number(item.quantity) || 0,
      refused: true,
      error: res.error || "That size/colour could not be updated.",
    };
  }

  const applied = Number(res.applied) || 0;
  const quantityAfter = Number(res.item?.quantity ?? item.quantity) || 0;
  return {
    item: { ...item, quantity: quantityAfter, status: res.item?.status ?? item.status },
    deducted: applied < 0 ? Math.abs(applied) : 0,
    added: applied > 0 ? applied : 0,
    quantityAfter,
    variantId,
  };
}

/** Human label for a variant row (used by callers building messages). */
export { variantLabelOf };

/**
 * Plain-language refusal message for a stock write, or `null` when it applied.
 * Routes use it to turn a refused movement into a clear 400 instead of a
 * silent no-op: "This product is stocked by size/colour — choose the
 * combination to move."
 */
export function stockRefusal(applied: { refused?: boolean; error?: string } | null | undefined): string | null {
  if (applied && applied.refused) return applied.error || "That stock movement could not be applied.";
  return null;
}
