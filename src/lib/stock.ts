import { db } from "@/db";
import { inventoryItems } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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
      category: opts.category,
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
}) {
  const qty = Number(opts.quantity) || 0;
  if (qty <= 0) return null;
  const item = await ensureInventoryItem({ ...opts });
  const newQty = (item.quantity || 0) + qty;
  const set: any = {
    quantity: newQty,
    status: computeStockStatus(newQty, item.minStockThreshold || 0),
  };
  if (opts.costPriceGhs && opts.costPriceGhs > 0) set.costPriceGhs = opts.costPriceGhs;
  if (opts.sellingPriceGhs && opts.sellingPriceGhs > 0) set.sellingPriceGhs = opts.sellingPriceGhs;
  const [updated] = await db
    .update(inventoryItems)
    .set(set)
    .where(eq(inventoryItems.id, item.id))
    .returning();
  return updated;
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
}) {
  const qty = Number(opts.quantity) || 0;
  if (qty <= 0) return { deducted: 0, item: null as any };

  let item: any = null;
  if (opts.inventoryId) {
    const [found] = await db
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, Number(opts.inventoryId)), eq(inventoryItems.businessId, opts.businessId))
      );
    item = found || null;
  }
  if (!item && (opts.sku || opts.name)) {
    const items = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.businessId, opts.businessId));
    item =
      (opts.sku && items.find((i) => (i.sku || "").toUpperCase() === opts.sku!.toUpperCase())) ||
      (opts.name && items.find((i) => (i.name || "").toLowerCase() === opts.name!.toLowerCase())) ||
      null;
  }
  if (!item) return { deducted: 0, item: null as any };

  const deducted = Math.min(qty, item.quantity || 0);
  const newQty = (item.quantity || 0) - deducted;
  const [updated] = await db
    .update(inventoryItems)
    .set({
      quantity: newQty,
      status: computeStockStatus(newQty, item.minStockThreshold || 0),
    })
    .where(eq(inventoryItems.id, item.id))
    .returning();
  return { deducted, item: updated };
}
