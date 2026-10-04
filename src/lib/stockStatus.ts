/**
 * The shared stock-status rule (IN_STOCK / LOW_STOCK / OUT_OF_STOCK).
 *
 * Lives in its own module so BOTH stock writers can use it without importing
 * each other: `stock.ts` (item-level quantity) and `variantStock.ts`
 * (size/colour rows + the aggregate it derives). `src/lib/stock.ts` re-exports
 * it, so every existing `import { computeStockStatus } from "@/lib/stock"`
 * keeps working unchanged.
 */
export function computeStockStatus(quantity: number, minStockThreshold: number) {
  if (quantity <= 0) return "OUT_OF_STOCK";
  if (quantity <= (minStockThreshold || 0)) return "LOW_STOCK";
  return "IN_STOCK";
}
