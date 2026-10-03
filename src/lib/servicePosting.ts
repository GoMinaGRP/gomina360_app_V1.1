/**
 * Service-sale posting — the ONE writer for module revenue that is not a
 * goods sale (car-wash jobs, telecom sales/commissions, transport fares and
 * bookings).
 *
 * These modules each used to hand-roll their own `insert(transactions)` for
 * INCOME: same columns, slightly different defaults, four copies of the row
 * shape. They keep their own pricing, categories and domain records — only the
 * ledger row is shared, so numbering, status and the recorded-by convention can
 * never drift between them again.
 *
 * Expenses deliberately do NOT come through here: they go to
 * `postOrGateExpenseTransaction` (approval-gated).
 */
import { db } from "@/db";
import { businesses, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nextTrxNumber } from "@/lib/idNumbers";
import { linkOrCreateCustomer } from "@/lib/customerLink";

export interface ServiceSaleActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

export interface PostServiceSaleOptions {
  businessId: number;
  branchCode?: string | null;
  branchName?: string | null;
  /** Ledger category, e.g. "Car Wash Service", "TELECOM_SALE", "Transport Fuel". */
  category: string;
  description: string;
  amountGhs: number;
  paymentMethod?: string | null;
  date?: string | null;
  customerId?: number | null;
  supplierId?: number | null;
  actor?: ServiceSaleActor;
  /** Fallback `recordedBy` when no actor name is supplied (e.g. "Auto Wash"). */
  recordedByFallback?: string | null;
  /** When set, the buyer's CRM row is matched/accrued in the same call. */
  customerName?: string | null;
  customerPhone?: string | null;
  crmAccrue?: boolean;
  /** Loyalty award override (service modules historically use 1 per job). */
  loyaltyPoints?: number;
  /** Stored when the buyer has no phone number. */
  phoneFallback?: string | null;
  /** Free-form tag kept in the description for cross-module traceability. */
  tag?: string | null;
}

export interface PostServiceSaleResult {
  success: boolean;
  transaction?: any;
  customerId?: number | null;
  error?: string;
}

export async function postServiceSale(opts: PostServiceSaleOptions): Promise<PostServiceSaleResult> {
  const amount = Number(opts.amountGhs);
  const businessId = Number(opts.businessId);
  if (!businessId) return { success: false, error: "businessId is required" };
  if (!Number.isFinite(amount) || amount < 0) return { success: false, error: "A valid amount is required" };

  const now = new Date();
  const dateStr = opts.date || now.toISOString().split("T")[0];

  let branchCode = opts.branchCode ?? null;
  let branchName = opts.branchName ?? null;
  if (!branchCode || !branchName) {
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    branchCode = branchCode ?? biz?.code ?? null;
    branchName = branchName ?? biz?.name ?? null;
  }

  // Buyer (optional): the shared CRM matcher, business-isolated.
  let customerId = opts.customerId ?? null;
  if (opts.crmAccrue && opts.customerName != null && customerId == null) {
    const linked = await linkOrCreateCustomer({
      businessId,
      name: opts.customerName,
      phone: opts.customerPhone,
      amount,
      loyaltyPoints: opts.loyaltyPoints,
      phoneFallback: opts.phoneFallback ?? "—",
    });
    customerId = linked?.id ?? null;
  }

  try {
    const [row] = await db
      .insert(transactions)
      .values({
        transactionNumber: nextTrxNumber(now),
        businessId,
        branchCode,
        branchName,
        type: "INCOME",
        category: opts.category,
        amountGhs: amount,
        paymentMethod: opts.paymentMethod || "CASH",
        customerId,
        supplierId: opts.supplierId ?? null,
        description: opts.tag ? `[${opts.tag}] ${opts.description}` : opts.description,
        date: dateStr,
        createdAt: now,
        status: "COMPLETED",
        recordedBy: opts.actor?.name || opts.recordedByFallback || "System",
        recordedByRole: opts.actor?.role || null,
        recordedByUserId: opts.actor?.id != null ? Number(opts.actor.id) : null,
      })
      .returning();
    return { success: true, transaction: row, customerId };
  } catch (e: any) {
    console.error("[service-sale] post failed:", e);
    return { success: false, error: e?.message || "Could not post the sale" };
  }
}
