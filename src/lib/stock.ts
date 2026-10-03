import { db } from "@/db";
import { inventoryItems, stockMovements, businesses } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { normalizeInventoryCategory, deriveInventorySubcategory } from "@/lib/inventoryCategories";

/**
 * Shared stock helpers — every module (production, harvest, purchases, sales)
 * funnels quantity changes through these so inventory, dashboards, alerts and
 * reports always stay in sync.
 */

export function computeStockStatus(quantity: number, minStockThreshold: number) {
  if (quantity <= 0) return "OUT_OF_STOCK";
  if (quantity <= (minStockThreshold || 0)) return "LOW_STOCK";
  return "IN_STOCK";
}

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
    try {
      let branchCode = opts.branchCode || (item as any).branchCode || null;
      if (!branchCode) {
        const [biz] = await db.select({ code: businesses.code }).from(businesses).where(eq(businesses.id, businessId));
        branchCode = biz?.code || null;
      }
      await db.insert(stockMovements).values({
        businessId,
        branchCode,
        inventoryId: item.id,
        sku: item.sku || null,
        itemName: item.name || null,
        delta,
        quantityAfter: next,
        reason: String(opts.reason || "ADJUSTMENT"),
        refType: opts.refType || null,
        refId: opts.refId != null ? Number(opts.refId) : null,
        note: opts.note || null,
        variantId: opts.variantId != null ? Number(opts.variantId) : null,
        actorUserId: opts.actor?.id != null ? Number(opts.actor.id) : null,
        actorName: opts.actor?.name || null,
        actorRole: opts.actor?.role || null,
      });
    } catch (e) {
      // The movement trail must never break the operation that moved stock.
      console.error("[stock] movement log failed:", e);
    }
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
    setCostPriceGhs: opts.costPriceGhs,
    setSellingPriceGhs: opts.sellingPriceGhs,
  });
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
}) {
  const qty = Number(opts.quantity) || 0;
  if (qty <= 0) return { deducted: 0, item: null as any };
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
  });
  return { deducted: applied.deducted, item: applied.item };
}
