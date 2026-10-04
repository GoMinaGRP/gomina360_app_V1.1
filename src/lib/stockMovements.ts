/**
 * THE stock-movement trail writer.
 *
 * Every quantity change in the product — item-level OR size/colour-level —
 * appends exactly one row here, through this one function, so "why is stock 42
 * and not 50?" always has an answer (P5/P6: one writer per data family).
 *
 * Kept dependency-free (db + schema only) so both stock writers can import it:
 *   • src/lib/stock.ts        — item-level movements
 *   • src/lib/variantStock.ts — size/colour movements (rows carry `variantId`)
 *
 * A failed movement insert must NEVER break the operation that moved stock, so
 * every error is logged and swallowed.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, stockMovements } from "@/db/schema";

export interface StockMovementInput {
  businessId: number;
  branchCode?: string | null;
  inventoryId: number;
  sku?: string | null;
  itemName?: string | null;
  /** The signed change that was applied (after clamping). */
  delta: number;
  quantityAfter: number;
  reason: string;
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  variantId?: number | null;
  actor?: { id?: number | null; name?: string | null; role?: string | null } | null;
}

export async function logStockMovement(opts: StockMovementInput): Promise<void> {
  try {
    let branchCode = opts.branchCode || null;
    if (!branchCode) {
      const [biz] = await db
        .select({ code: businesses.code })
        .from(businesses)
        .where(eq(businesses.id, Number(opts.businessId)));
      branchCode = biz?.code || null;
    }
    await db.insert(stockMovements).values({
      businessId: Number(opts.businessId),
      branchCode,
      inventoryId: Number(opts.inventoryId),
      sku: opts.sku || null,
      itemName: opts.itemName || null,
      delta: Number(opts.delta) || 0,
      quantityAfter: Number(opts.quantityAfter) || 0,
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
