/**
 * Boutique server library — the DOMAIN layer on top of the variant-stock family.
 *
 * Design rules (owner directive: reuse the best existing architecture):
 *  • `inventory_items` stays the ONE stock register: its `quantity` is the
 *    live AGGREGATE of the item's active variants, so Sales, Purchases,
 *    Orders, Low Stock, Finance, Reports, Exports and Audit keep working with
 *    zero changes to their data contract.
 *  • `inventory_variants` only answers the sub-line question the register
 *    could not: WHICH size/colour moved.
 *  • The variant stock FAMILY (matrix writes, adjustments, atomic deductions,
 *    the derived aggregate, reorder reads) lives in `src/lib/variantStock.ts` —
 *    one writer per data family (P6). This module keeps the boutique-specific
 *    READS (grouping, storefront projection, line validation) and re-exports
 *    the family so every existing `@/lib/boutique` import keeps working.
 *  • All reads/writes are business-scoped; callers pass the businessId they
 *    already access-checked.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryVariants } from "@/db/schema";
import {
  activeVariantsByItem,
  variantsForItem,
  type VariantRow,
} from "@/lib/variantStock";

// ── The variant stock family (src/lib/variantStock.ts) ─────────────────────
// Re-exported so existing callers keep their import paths unchanged.
export {
  activeVariantsByItem,
  adjustVariantStock,
  applyVariantDelta,
  countActiveVariants,
  deactivateVariant,
  deductVariantQty,
  lowStockVariantsForBusiness,
  restoreVariantQty,
  setVariantsForItem,
  syncItemAggregate,
  variantLabelOf,
  variantsForItem,
} from "@/lib/variantStock";
export type { VariantRow } from "@/lib/variantStock";

/** Every active variant row of one business, grouped by inventory item id. */
export async function listVariantsByItem(
  businessId: number,
  inventoryIds?: number[],
): Promise<Map<number, VariantRow[]>> {
  return activeVariantsByItem(businessId, inventoryIds);
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

/** True when an item carries an active size/colour matrix. */
export async function itemTracksVariants(businessId: number, inventoryId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: inventoryVariants.id })
    .from(inventoryVariants)
    .where(
      and(
        eq(inventoryVariants.businessId, Number(businessId)),
        eq(inventoryVariants.inventoryId, Number(inventoryId)),
        eq(inventoryVariants.isActive, true),
      ),
    )
    .limit(1);
  return !!row;
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
