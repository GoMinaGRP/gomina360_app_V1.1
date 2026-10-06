/**
 * Shared sale posting engine — the ONE place a completed sale becomes money.
 *
 * Before this module the same three facts (ledger transaction, receipt,
 * customer + tracking) were written by three different code paths:
 *   • `/api/sales`            — the canonical pipeline (stock, receipt, CRM, tracking);
 *   • Hardware order delivery — hand-rolled `insert(transactions)`, no receipt/CRM/tracking;
 *   • Electronics delivery    — a second hand-rolled insert, same gaps.
 * Restaurant kitchen tickets posted nothing at all. Depending on which screen a
 * sale was rung up on, Finance, Receipts, the CRM and Order & Tracking saw
 * different data — the "second sales pipeline" the audit flagged.
 *
 * Now every path calls `postSale()`:
 *   ledger INCOME transaction → RECEIPT sales document → CRM link/accrual →
 *   customer tracking code, with the same totals, COGS, profit and discount
 *   maths as the Sales Center.
 *
 * Callers keep their own domain work (stock deduction, serials, ticket status)
 * and their own ledger category/description, so nothing about day-to-day
 * workflows changes — only the recording is unified.
 */
import { db } from "@/db";
import { transactions, salesDocuments, customerTrackings, businesses } from "@/db/schema";
import { nextSalesDocumentNumber } from "@/lib/documentNumbers";
import { eq } from "drizzle-orm";
import { nextTrxNumber } from "@/lib/idNumbers";
import { buildTrackingCode } from "@/lib/tracking";
import { ttlInvalidate } from "@/lib/ttlCache";
import { linkOrCreateCustomer, isAnonymousBuyer } from "@/lib/customerLink";

export interface SaleLineInput {
  inventoryId?: number | null;
  sku?: string | null;
  /** Human description stored on the receipt/tracking (e.g. "Cement 50kg (HW-CEM)"). */
  description: string;
  quantity: number;
  unit?: string | null;
  category?: string | null;
  unitPrice: number;
  originalPrice?: number | null;
  costPrice?: number | null;
  variantId?: number | null;
  variantSku?: string | null;
  size?: string | null;
  color?: string | null;
  customPriceReason?: string | null;
  /** Pre-computed line total (defaults to quantity × unitPrice). */
  total?: number;
}

export interface PostSaleActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

export interface PostSaleOptions {
  businessId: number;
  branchCode?: string | null;
  lines: SaleLineInput[];
  customerName?: string | null;
  customerPhone?: string | null;
  /** Pre-linked CRM customer (skips the lookup/creation). */
  customerId?: number | null;
  paymentMethod?: string | null;
  notes?: string | null;
  discount?: number | null;
  discountPercent?: number | null;
  /** Ledger category. Default "Inventory Sale" (the Sales Center category). */
  category?: string;
  /** Ledger description override — modules keep their own wording. */
  description?: string | null;
  /** Prefix tag inside the generated description. Default "INV". */
  tag?: string;
  /** Create the RECEIPT sales document. Default true. */
  receipt?: boolean;
  /** Mint a customer tracking code + tracking row. Default true. */
  tracking?: boolean;
  /** Link/accrue the CRM customer. Default true. */
  linkCustomer?: boolean;
  /** Accrue loyalty points. Default ⌊total/100⌋ (Sales Center rule). */
  loyaltyPoints?: number;
  actor?: PostSaleActor;
  /** Business date (YYYY-MM-DD). Default today. */
  date?: string | null;
  /** Amount used for CRM accrual when it differs from the sale total. */
  customerSpendOverride?: number | null;
}

export interface SaleTotals {
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  total: number;
  cogs: number;
  grossProfit: number;
}

export interface PostSaleResult {
  success: boolean;
  error?: string;
  totals: SaleTotals;
  lineItems: any[];
  transaction: any | null;
  receipt: any | null;
  customerId: number | null;
  customerLinked: boolean;
  trackingCode: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Normalise caller lines into the receipt shape (same fields /api/sales stores). */
export function normalizeSaleLines(lines: SaleLineInput[]): any[] {
  return (lines || []).map((li) => {
    const quantity = Number(li.quantity) || 0;
    const unitPrice = Number(li.unitPrice) || 0;
    const costPrice = Number(li.costPrice) || 0;
    const total = li.total !== undefined ? r2(Number(li.total)) : r2(unitPrice * quantity);
    const costTotal = r2(costPrice * quantity);
    return {
      inventoryId: li.inventoryId != null ? Number(li.inventoryId) : undefined,
      sku: li.sku || null,
      description: li.description,
      ...(li.variantId
        ? {
            variantId: Number(li.variantId),
            variantSku: li.variantSku || null,
            size: li.size || null,
            color: li.color || null,
          }
        : {}),
      category: li.category || null,
      quantity,
      unit: li.unit || null,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : unitPrice,
      unitPrice,
      total,
      costPrice,
      costTotal,
      lineProfit: r2(total - costTotal),
      ...(li.customPriceReason ? { customPriceReason: li.customPriceReason } : {}),
    };
  });
}

/**
 * Discount/total maths — the single implementation shared by the Sales Center
 * route (for its pre-validation) and every posting path.
 */
export function computeSaleTotals(
  lineItems: any[],
  discount?: number | null,
  discountPercent?: number | null,
): { totals?: SaleTotals; error?: string } {
  const subtotal = r2(lineItems.reduce((acc: number, li: any) => acc + (Number(li.total) || 0), 0));
  let discountPct = 0;
  let discountAmount = 0;
  if (discountPercent !== undefined && discountPercent !== null && (discountPercent as any) !== "") {
    const pct = Number(discountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { error: "Discount percent must be between 0 and 100." };
    }
    discountPct = r2(pct);
    discountAmount = r2((subtotal * discountPct) / 100);
  } else {
    discountAmount = r2(Number(discount) || 0);
    discountPct = subtotal > 0 ? r2((discountAmount / subtotal) * 100) : 0;
  }
  if (discountAmount < 0 || discountAmount > subtotal) {
    return { error: "Discount cannot exceed the sale subtotal." };
  }
  const total = r2(subtotal - discountAmount);
  const cogs = r2(lineItems.reduce((acc: number, li: any) => acc + (Number(li.costTotal) || 0), 0));
  return { totals: { subtotal, discountPct, discountAmount, total, cogs, grossProfit: r2(total - cogs) } };
}

/**
 * Post a completed sale. Returns the created rows; on a validation failure
 * (`bad discount`) returns `success: false` with the same message the Sales
 * Center API has always used.
 */
export async function postSale(opts: PostSaleOptions): Promise<PostSaleResult> {
  const businessId = Number(opts.businessId);
  const actor: PostSaleActor = opts.actor || {};
  const customerName = opts.customerName ? String(opts.customerName).trim() : "";
  const customerPhone = opts.customerPhone ? String(opts.customerPhone).trim() : "";
  const lineItems = normalizeSaleLines(opts.lines);

  const { totals, error } = computeSaleTotals(lineItems, opts.discount, opts.discountPercent);
  if (error || !totals) {
    return {
      success: false,
      error: error || "Invalid sale totals.",
      totals: { subtotal: 0, discountPct: 0, discountAmount: 0, total: 0, cogs: 0, grossProfit: 0 },
      lineItems,
      transaction: null,
      receipt: null,
      customerId: opts.customerId ?? null,
      customerLinked: false,
      trackingCode: null,
    };
  }

  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const resolvedBranchCode = opts.branchCode || biz?.code || "";
  const resolvedBranchName = biz?.name || "";
  const dateStr = opts.date || new Date().toISOString().split("T")[0];

  // ── 1. CRM link (shared rule) ─────────────────────────────────────────────
  let linkedCustomerId: number | null = opts.customerId != null ? Number(opts.customerId) : null;
  let customerLinked = false;
  if (opts.linkCustomer !== false && (linkedCustomerId != null || customerName || customerPhone)) {
    const linked = await linkOrCreateCustomer({
      businessId,
      // A pre-linked buyer (module orders) accrues on the very same row.
      byId: linkedCustomerId,
      name: isAnonymousBuyer(customerName) ? "" : customerName,
      phone: customerPhone,
      amount: opts.customerSpendOverride != null ? Number(opts.customerSpendOverride) : totals.total,
      loyaltyPoints: opts.loyaltyPoints,
      phoneFallback: "",
      includeLegacyShared: true,
    });
    if (linked) {
      linkedCustomerId = linked.id;
      customerLinked = true;
    }
  }

  // ── 2. Ledger INCOME transaction ─────────────────────────────────────────
  const trxNum = nextTrxNumber();
  const lineDesc = lineItems.map((li: any) => `${li.quantity}× ${li.description}`).join(", ");
  const discountNote =
    totals.discountAmount > 0 ? ` · ${totals.discountPct}% discount −GH₵${totals.discountAmount.toFixed(2)}` : "";
  const description =
    opts.description ||
    `[${opts.tag || "INV"}:${trxNum}] ${lineDesc} — ${customerName || "Walk-in"}${discountNote}`;

  const [newTrx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId,
      branchCode: resolvedBranchCode,
      branchName: resolvedBranchName,
      type: "INCOME",
      category: opts.category || "Inventory Sale",
      amountGhs: totals.total,
      paymentMethod: opts.paymentMethod || "CASH",
      customerId: linkedCustomerId,
      description,
      date: dateStr,
      createdAt: new Date(),
      status: "COMPLETED",
      recordedBy: actor.name || "Sales Center",
      recordedByRole: actor.role || null,
      recordedByUserId: actor.id ? Number(actor.id) : null,
    })
    .returning();

  // ── 3. Receipt (sales document) ──────────────────────────────────────────
  let newDoc: any = null;
  if (opts.receipt !== false) {
    // ONE numbering source (src/lib/documentNumbers) — collision-safe sequence.
    const docNum = await nextSalesDocumentNumber("RECEIPT");
    [newDoc] = await db
      .insert(salesDocuments)
      .values({
        documentNumber: docNum,
        documentType: "RECEIPT",
        businessId,
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: customerName || "Walk-in Customer",
        customerPhone: customerPhone || null,
        lineItems,
        subtotalGhs: totals.subtotal,
        discountGhs: totals.discountAmount,
        discountPercent: totals.discountPct,
        totalGhs: totals.total,
        cogsGhs: totals.cogs,
        grossProfitGhs: totals.grossProfit,
        currency: "GHS",
        status: "PAID",
        notes: opts.notes || null,
        paymentMethod: opts.paymentMethod || "CASH",
        linkedTransactionId: newTrx?.id ?? null,
        createdByUserId: actor.id ? Number(actor.id) : null,
        createdByName: actor.name || "Sales Center",
        createdByRole: actor.role || null,
      })
      .returning();
  }

  // ── 4. Customer tracking code (public /track page) ────────────────────────
  let trackingCode: string | null = null;
  if (opts.tracking !== false) {
    try {
      let code = buildTrackingCode(biz?.code);
      for (let i = 0; i < 6; i++) {
        const clash = await db
          .select({ id: customerTrackings.id })
          .from(customerTrackings)
          .where(eq(customerTrackings.trackingCode, code));
        if (clash.length === 0) break;
        code = buildTrackingCode(biz?.code);
      }
      const now = new Date();
      await db.insert(customerTrackings).values({
        trackingCode: code,
        businessId,
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: customerName || "Walk-in Customer",
        customerPhone: customerPhone || null,
        saleDocumentId: newDoc?.id ?? null,
        transactionId: newTrx?.id ?? null,
        items: lineItems.map((li: any) => ({
          description: li.description,
          sku: li.sku || null,
          quantity: li.quantity,
          unit: li.unit || null,
          unitPrice: li.unitPrice,
          total: li.total,
          ...(li.size || li.color
            ? { size: li.size || null, color: li.color || null, variantId: li.variantId ?? null }
            : {}),
        })),
        totalGhs: totals.total,
        currency: "GHS",
        fulfillmentType: "PICKUP",
        status: "RECEIVED",
        statusHistory: [
          {
            status: "RECEIVED",
            at: now.toISOString(),
            by: actor.name || "Sales Center",
            byRole: actor.role || "WORKER",
            note: `Sale recorded (${newDoc?.documentNumber || trxNum}). Order registered for customer tracking.`,
          },
        ],
        orderSource: "SALE",
        paymentChoice: null,
        paymentStatus: "PAID",
        paymentMethod: opts.paymentMethod || "CASH",
        paymentMarkedBy: actor.name || "Sales Center",
        paymentMarkedAt: now,
        stockCommitted: true,
        createdByUserId: actor.id ? Number(actor.id) : null,
        createdByName: actor.name || "Sales Center",
        createdByRole: actor.role || null,
        createdAt: now,
        updatedAt: now,
      });
      trackingCode = code;
    } catch (trackErr) {
      console.error("[sale-posting] tracking warning:", trackErr);
    }
  }

  ttlInvalidate("init");

  // Money activity → the unit's money watchers (bell + one push per day).
  // Rolled up per business/day by notifyActivity; never blocks the sale.
  {
    const { notifyMoneyActivity } = await import("@/lib/notifyActivity");
    await notifyMoneyActivity({
      businessId,
      branchCode: resolvedBranchCode,
      kind: "SALE",
      amountGhs: totals.total,
      actorName: actor.name || "Sales Center",
      actorUserId: actor.id ?? null,
      recordRef: newDoc?.documentNumber || trxNum,
      recordId: Number(newTrx?.id) || null,
      recordType: "transactions",
      label: `${opts.category || "Sale"}${customerName ? ` to ${customerName}` : ""}`,
    });
  }

  return {
    success: true,
    totals,
    lineItems,
    transaction: newTrx,
    receipt: newDoc,
    customerId: linkedCustomerId,
    customerLinked,
    trackingCode,
  };
}
