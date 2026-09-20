/**
 * Shared supplier-ledger linking (`src/lib/supplierLinks.ts`).
 *
 * Used by module raw-material intake paths (poultry feed mill, fish feed mill,
 * block-factory RESTOCK, …) so that naming a supplier on an intake
 * automatically creates/refreshes that supplier in the org-wide Suppliers
 * ledger — the feed-mill pattern, now shared instead of duplicated per route.
 *
 * Semantics mirror the original poultry feed-mill behaviour exactly:
 *  - links are org-scoped (suppliers.ownerId = organizations.id), never business-scoped;
 *  - match an existing supplier by case-insensitive name within the org;
 *  - existing record  → accrue the intake's goods value onto totalSuppliedGhs;
 *  - new record       → create with the module's category and derive payment
 *                       terms from the intake's payment method;
 *  - NEVER throws: every failure degrades to `{ supplier: null, linked: false }`
 *    (the intake itself must still succeed) and logs to the server console.
 */
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function linkSupplier(opts: {
  ownerId: number | null | undefined;
  name: string;
  category: string; // e.g. "Poultry Feed" | "Fish Feed" | "Cement & Aggregates"
  suppliedGhs?: number | null; // goods value of this intake
  paymentMethod?: string | null; // CASH | MOMO | BANK_TRANSFER | CREDIT …
  logTag?: string; // e.g. "[fish-mill]"
}): Promise<{ supplier: any | null; linked: boolean }> {
  const ownerId = Number(opts.ownerId) || 0;
  const supName = String(opts.name || "").trim().slice(0, 120);
  if (!ownerId || !supName) return { supplier: null, linked: false };
  const totalCost = Math.max(0, Number(opts.suppliedGhs) || 0);
  try {
    const existing = await db.select().from(suppliers).where(eq(suppliers.ownerId, ownerId));
    const found = existing.find((s: any) => (s.name || "").toLowerCase() === supName.toLowerCase());
    if (found) {
      const [upd] = await db.update(suppliers)
        .set({ totalSuppliedGhs: Math.round(((found.totalSuppliedGhs || 0) + totalCost) * 100) / 100 })
        .where(eq(suppliers.id, found.id)).returning();
      return { supplier: upd || found, linked: true };
    }
    const [row] = await db.insert(suppliers).values({
      name: supName,
      category: opts.category,
      contactPerson: "—",
      phone: "—",
      paymentTerms: opts.paymentMethod === "CREDIT" ? "NET_14" : "CASH_ON_DELIVERY",
      ownerId,
      totalSuppliedGhs: Math.round(totalCost * 100) / 100,
    }).returning();
    return { supplier: row, linked: true };
  } catch (e) {
    console.error(`${opts.logTag || "[supplier-link]"} supplier link failed:`, e);
    return { supplier: null, linked: false };
  }
}
