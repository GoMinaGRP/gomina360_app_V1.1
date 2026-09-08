import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  creditSales,
  creditPayments,
  inventoryItems,
  transactions,
  salesDocuments,
  businesses,
  customers,
  customerTrackings,
} from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  filterByAccess,
  UNAUTHENTICATED,
  FORBIDDEN,
} from "@/lib/auth";
import {
  buildCreditCode,
  buildCreditPaymentNumber,
  normalizeCreditLookupCode,
  r2,
  SETTLED_EPSILON,
} from "@/lib/credit";
import { uniqueTrackingCode } from "@/lib/trackingServer";

/**
 * /api/credit-sales — Credit Sale lifecycle.
 *
 * GET  ?businessId=&status=&customerId=&code=&includePayments=1
 *      → branch-isolated register + summary tile totals
 *        (Credit Sales total / Amount Paid / Outstanding Balance).
 *        `code` looks a sale up by the customer's GM-* tracking code OR the
 *        staff CRD-* credit code — this is how the register finds a sale from
 *        the secure order/customer code.
 *
 * POST { action:"create", businessId, branchCode?, customerName*, customerPhone?,
 *        cartItems*, discountPercent?|discount?, depositAmount?, depositMethod?,
 *        depositReference?, dueDate?, notes? }
 *      → validates stock, deducts inventory, links CRM customer, mints the
 *        GM-* tracking code, creates the CREDIT invoice, and (when a deposit
 *        is given) records the first installment exactly like `pay`.
 *
 * POST { action:"pay", creditSaleId? | code?, amount*, paymentMethod*,
 *        reference?, note? }
 *      → records one installment: credit_payments row + INCOME transaction
 *        ("Credit Installment") + RECEIPT document; when the balance reaches
 *        zero the sale flips to PAID and the order's payment status flips to
 *        PAID across Customer Tracking and the invoice.
 *
 * DATA ISOLATION: the session user must have access to the sale's business
 * (OWNER: all; managers/workers: assigned + granted only) — enforced here
 * server-side on every read and every mutation.
 */

const round2 = r2;

interface CartLine {
  inventoryId: number;
  quantity: number;
  sellingPrice?: number;
  customPriceReason?: string;
}

/** Validate + reserve a cart against inventory (identical rules to /api/sales). */
async function validateCart(businessId: number, cartItems: CartLine[]) {
  const validationErrors: string[] = [];
  const inventoryUpdates: { id: number; newQty: number; newStatus: string }[] = [];
  const lineItems: any[] = [];

  for (const item of cartItems || []) {
    const { inventoryId, quantity, sellingPrice } = item;
    if (!inventoryId || !quantity || quantity <= 0) {
      validationErrors.push("Invalid cart item: missing inventoryId or quantity.");
      continue;
    }
    const [inv] = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, Number(inventoryId)));
    if (!inv) {
      validationErrors.push(`Product #${inventoryId} not found in inventory.`);
      continue;
    }
    if (inv.businessId !== Number(businessId)) {
      validationErrors.push(`Product "${inv.name}" does not belong to this branch.`);
      continue;
    }
    if (inv.status === "OUT_OF_STOCK" || inv.quantity <= 0) {
      validationErrors.push(`"${inv.name}" is OUT OF STOCK and cannot be sold on credit.`);
      continue;
    }
    if (Number(quantity) > inv.quantity) {
      validationErrors.push(
        `Insufficient stock for "${inv.name}": requested ${quantity}, available ${inv.quantity} ${inv.unit}.`
      );
      continue;
    }
    const effectivePrice = Number(sellingPrice) || inv.sellingPriceGhs;
    const itemTotal = round2(effectivePrice * Number(quantity));
    const newQty = inv.quantity - Number(quantity);
    const newStatus =
      newQty <= 0 ? "OUT_OF_STOCK" : newQty <= inv.minStockThreshold ? "LOW_STOCK" : "IN_STOCK";
    inventoryUpdates.push({ id: inv.id, newQty, newStatus });
    lineItems.push({
      inventoryId: inv.id,
      sku: inv.sku,
      description: `${inv.name} (${inv.sku})`,
      category: inv.category,
      quantity: Number(quantity),
      unit: inv.unit,
      originalPrice: inv.sellingPriceGhs,
      unitPrice: effectivePrice,
      total: itemTotal,
      costPrice: inv.costPriceGhs || 0,
      costTotal: (inv.costPriceGhs || 0) * Number(quantity),
      lineProfit: itemTotal - (inv.costPriceGhs || 0) * Number(quantity),
    });
  }
  return { validationErrors, inventoryUpdates, lineItems };
}

/** Find-or-create the CRM customer and accrue their spend (business-isolated). */
async function linkCustomer(
  businessId: number,
  customerName: string,
  customerPhone: string | null,
  total: number
): Promise<number | null> {
  const allCustomers = await db.select().from(customers);
  const norm = (s: any) => String(s || "").trim().toLowerCase();
  const belongs = (c: any) => c.businessId === Number(businessId);
  const shared = (c: any) => c.businessId === null;
  const cust =
    (customerPhone && allCustomers.find((c) => norm(c.phone) === norm(customerPhone) && belongs(c))) ||
    (customerName && allCustomers.find((c) => norm(c.name) === norm(customerName) && belongs(c))) ||
    (customerPhone && allCustomers.find((c) => norm(c.phone) === norm(customerPhone) && shared(c))) ||
    (customerName && allCustomers.find((c) => norm(c.name) === norm(customerName) && shared(c))) ||
    null;
  if (cust) {
    await db
      .update(customers)
      .set({
        totalSpentGhs: (cust.totalSpentGhs || 0) + total,
        loyaltyPoints: (cust.loyaltyPoints || 0) + Math.floor(total / 100),
      })
      .where(eq(customers.id, cust.id));
    return cust.id;
  }
  const [created] = await db
    .insert(customers)
    .values({
      name: customerName.trim(),
      type: "RETAIL",
      phone: customerPhone || "",
      totalSpentGhs: total,
      loyaltyPoints: Math.floor(total / 100),
      businessId: Number(businessId),
    })
    .returning();
  return created?.id ?? null;
}

/**
 * Post one installment across Credit + Finance + Receipts and (when the
 * balance settles) flip the order/invoice to PAID. Shared by create-deposit
 * and the standalone pay action. Assumes access + amounts already validated.
 */
async function postInstallment({
  credit,
  amount,
  paymentMethod,
  reference,
  note,
  receivedByUserId,
  receivedByName,
  receivedByRole,
  descriptionTag,
}: {
  credit: any;
  amount: number;
  paymentMethod: string;
  reference?: string | null;
  note?: string | null;
  receivedByUserId: number | null;
  receivedByName: string | null;
  receivedByRole: string | null;
  descriptionTag: "Credit Deposit" | "Credit Installment";
}) {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const payNum = buildCreditPaymentNumber();

  // 1. Finance — INCOME transaction (feeds Payments, Reports, dashboards).
  const trxNum = `TRX-${now.getFullYear()}-${Date.now().toString().slice(-6)}${Math.floor(
    Math.random() * 90 + 10
  )}`;
  const [trx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId: credit.businessId,
      branchCode: credit.branchCode,
      branchName: credit.branchName,
      type: "INCOME",
      category: descriptionTag,
      amountGhs: amount,
      paymentMethod,
      customerId: credit.customerId ?? null,
      description: `[CRD:${credit.creditCode}] ${descriptionTag} — ${credit.customerName} (order ${credit.trackingCode || "—"})${
        reference ? ` · ref ${reference}` : ""
      }`,
      date: dateStr,
      createdAt: now,
      status: "COMPLETED",
      recordedBy: receivedByName || "Sales Center",
      recordedByRole: receivedByRole || null,
      recordedByUserId: receivedByUserId,
    })
    .returning();

  // 2. Receipts — installment RECEIPT sales document.
  const docNum = `RCP-${now.getFullYear()}-${Date.now().toString().slice(-6)}${Math.floor(
    Math.random() * 90 + 10
  )}`;
  const [receipt] = await db
    .insert(salesDocuments)
    .values({
      documentNumber: docNum,
      documentType: "RECEIPT",
      businessId: credit.businessId,
      branchCode: credit.branchCode,
      branchName: credit.branchName,
      customerId: credit.customerId ?? null,
      customerName: credit.customerName,
      customerPhone: credit.customerPhone || null,
      lineItems: [
        {
          description: `${descriptionTag} — credit ${credit.creditCode} (order ${credit.trackingCode || "—"})`,
          quantity: 1,
          unitPrice: amount,
          total: amount,
        },
      ],
      subtotalGhs: amount,
      totalGhs: amount,
      currency: "GHS",
      status: "PAID",
      notes: note || null,
      paymentMethod,
      linkedTransactionId: trx.id,
      createdByUserId: receivedByUserId,
      createdByName: receivedByName || "Sales Center",
      createdByRole: receivedByRole || null,
    })
    .returning();

  // 3. Credit ledger row.
  const [payment] = await db
    .insert(creditPayments)
    .values({
      paymentNumber: payNum,
      creditSaleId: credit.id,
      businessId: credit.businessId,
      branchCode: credit.branchCode,
      branchName: credit.branchName,
      amountGhs: amount,
      paymentMethod,
      reference: reference || null,
      note: note || null,
      transactionId: trx.id,
      receiptDocumentId: receipt.id,
      receivedByUserId,
      receivedByName: receivedByName || null,
      receivedByRole: receivedByRole || null,
    })
    .returning();

  // 4. Roll the credit sale forward; settle when the balance is gone.
  const newPaid = round2((Number(credit.amountPaidGhs) || 0) + amount);
  const newBalance = Math.max(0, round2((Number(credit.totalGhs) || 0) - newPaid));
  const settled = newBalance <= SETTLED_EPSILON;
  const [updated] = await db
    .update(creditSales)
    .set({
      amountPaidGhs: newPaid,
      balanceGhs: newBalance,
      status: settled ? "PAID" : "ACTIVE",
      paidAt: settled ? now : null,
      updatedAt: now,
    })
    .where(eq(creditSales.id, credit.id))
    .returning();

  // 5. Settled → the whole chain flips to PAID (Tracking + Invoice).
  if (settled) {
    if (credit.trackingId) {
      await db
        .update(customerTrackings)
        .set({
          paymentStatus: "PAID",
          paymentMethod,
          paymentMarkedBy: receivedByName || "Sales Center",
          paymentMarkedAt: now,
          updatedAt: now,
        })
        .where(eq(customerTrackings.id, credit.trackingId));
    }
    if (credit.saleDocumentId) {
      await db
        .update(salesDocuments)
        .set({ status: "PAID" })
        .where(eq(salesDocuments.id, credit.saleDocumentId));
    }
  }

  return { payment, transaction: trx, receipt, creditSale: updated, settled };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const url = new URL(request.url);
    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;
    const statusFilter = (url.searchParams.get("status") || "").trim().toUpperCase();
    const customerFilter = Number(url.searchParams.get("customerId") || 0) || null;
    const codeLookup = normalizeCreditLookupCode(url.searchParams.get("code"));
    const includePayments = url.searchParams.get("includePayments") === "1";
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    const allowed = await accessibleBusinessIds(me);
    if (bizFilter && allowed !== null && !allowed.includes(bizFilter)) {
      return FORBIDDEN("You do not have access to that business's credit sales.");
    }

    let rows = filterByAccess(await db.select().from(creditSales), allowed);
    if (bizFilter) rows = rows.filter((r) => r.businessId === bizFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    if (customerFilter) rows = rows.filter((r) => r.customerId === customerFilter);
    if (codeLookup) {
      rows = rows.filter(
        (r) => r.creditCode.toUpperCase() === codeLookup || (r.trackingCode || "").toUpperCase() === codeLookup
      );
    }
    if (q) {
      rows = rows.filter(
        (r) =>
          r.creditCode.toLowerCase().includes(q) ||
          (r.trackingCode || "").toLowerCase().includes(q) ||
          (r.customerName || "").toLowerCase().includes(q) ||
          (r.customerPhone || "").toLowerCase().includes(q)
      );
    }
    rows = [...rows].sort(
      (a, b) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime()
    );

    let paymentsByCredit = new Map<number, any[]>();
    if (includePayments && rows.length) {
      const ids = rows.map((r) => r.id);
      const pays = await db
        .select()
        .from(creditPayments)
        .where(inArray(creditPayments.creditSaleId, ids))
        .orderBy(desc(creditPayments.createdAt));
      for (const p of pays) {
        const list = paymentsByCredit.get(p.creditSaleId) || [];
        list.push(p);
        paymentsByCredit.set(p.creditSaleId, list);
      }
    }

    const summary = {
      count: rows.length,
      activeCount: rows.filter((r) => r.status === "ACTIVE").length,
      paidCount: rows.filter((r) => r.status === "PAID").length,
      creditSalesTotalGhs: round2(rows.reduce((a, r) => a + (Number(r.totalGhs) || 0), 0)),
      amountPaidTotalGhs: round2(rows.reduce((a, r) => a + (Number(r.amountPaidGhs) || 0), 0)),
      outstandingBalanceTotalGhs: round2(rows.reduce((a, r) => a + (Number(r.balanceGhs) || 0), 0)),
    };

    return NextResponse.json(
      {
        success: true,
        scope: allowed === null ? "ALL" : allowed,
        creditSales: rows.map((r) => ({
          ...r,
          payments: includePayments ? paymentsByCredit.get(r.id) || [] : undefined,
          paymentsCount: includePayments ? (paymentsByCredit.get(r.id) || []).length : undefined,
        })),
        summary,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error: any) {
    console.error("GET /api/credit-sales error:", error);
    return NextResponse.json({ success: false, error: "Could not load credit sales." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const action = String(body.action || "create").toUpperCase();

    if (action === "PAY") {
      // ─── Record one installment (by sale id, GM-* tracking code or CRD code) ───
      const amount = round2(Number(body.amount));
      const paymentMethod = String(body.paymentMethod || "").trim().toUpperCase() || "CASH";
      const reference = body.reference ? String(body.reference).trim() : null;
      const note = body.note ? String(body.note).trim() : null;
      const codeLookup = normalizeCreditLookupCode(body.code || body.trackingCode);
      const creditSaleId = Number(body.creditSaleId || 0) || null;

      if ((!creditSaleId && !codeLookup) || !Number.isFinite(amount)) {
        return NextResponse.json(
          { success: false, error: "Provide the credit sale (id or tracking/credit code) and an amount." },
          { status: 400 }
        );
      }

      const all = await db.select().from(creditSales);
      const credit = creditSaleId
        ? all.find((c) => c.id === creditSaleId)
        : all.find(
            (c) =>
              c.creditCode.toUpperCase() === codeLookup ||
              (c.trackingCode || "").toUpperCase() === codeLookup
          );
      if (!credit) {
        return NextResponse.json(
          { success: false, error: "No credit sale found for that code. Check the receipt/tracking code." },
          { status: 404 }
        );
      }
      if (!(await canAccessBusiness(me, credit.businessId))) {
        return FORBIDDEN("You do not have access to this business's credit sales.");
      }
      if (credit.status !== "ACTIVE") {
        return NextResponse.json(
          { success: false, error: `Credit sale ${credit.creditCode} is already fully paid.` },
          { status: 400 }
        );
      }
      if (amount <= 0) {
        return NextResponse.json(
          { success: false, error: "Installment amount must be greater than zero." },
          { status: 400 }
        );
      }
      const balance = round2(Number(credit.balanceGhs) || 0);
      if (amount - balance > SETTLED_EPSILON) {
        return NextResponse.json(
          {
            success: false,
            error: `Amount GH₵${amount.toFixed(2)} exceeds the outstanding balance GH₵${balance.toFixed(2)}.`,
            balanceGhs: balance,
          },
          { status: 400 }
        );
      }
      const applied = Math.min(amount, balance);

      const result = await postInstallment({
        credit,
        amount: applied,
        paymentMethod,
        reference,
        note,
        receivedByUserId: me.id,
        receivedByName: me.name,
        receivedByRole: me.role,
        descriptionTag: "Credit Installment",
      });

      return NextResponse.json({
        success: true,
        ...result,
        outstandingGhs: result.creditSale.balanceGhs,
      });
    }

    // ─── CREATE a new credit sale ───
    const {
      businessId,
      branchCode,
      customerName,
      customerPhone,
      cartItems,
      notes,
      discount,
      discountPercent,
      dueDate,
    } = body;
    const depositAmount = round2(Number(body.depositAmount) || 0);
    const depositMethod = String(body.depositMethod || "CASH").trim().toUpperCase();
    const depositReference = body.depositReference ? String(body.depositReference).trim() : null;

    if (!businessId || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json(
        { success: false, error: "businessId and at least one cart item are required." },
        { status: 400 }
      );
    }
    if (!(await canAccessBusiness(me, Number(businessId)))) {
      return FORBIDDEN("You do not have access to sell on credit for that business.");
    }
    // Credit needs an identifiable customer — never an anonymous walk-in.
    const cleanName = String(customerName || "").trim();
    if (!cleanName || /^walk[- ]?in/i.test(cleanName)) {
      return NextResponse.json(
        { success: false, error: "A credit sale requires the customer's real name (no walk-in credit)." },
        { status: 400 }
      );
    }
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) {
      return NextResponse.json(
        { success: false, error: "Due date must be YYYY-MM-DD." },
        { status: 400 }
      );
    }
    if (depositAmount < 0) {
      return NextResponse.json(
        { success: false, error: "Deposit cannot be negative." },
        { status: 400 }
      );
    }

    // 1. Cart validation (same rules as a cash sale).
    const { validationErrors, inventoryUpdates, lineItems } = await validateCart(
      Number(businessId),
      cartItems
    );
    if (validationErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: validationErrors.join(" | "), errors: validationErrors },
        { status: 400 }
      );
    }

    // 2. Totals + discount (identical math to /api/sales).
    const subtotal = round2(lineItems.reduce((acc: number, li: any) => acc + li.total, 0));
    let discountPct = 0;
    let discountAmount = 0;
    if (discountPercent !== undefined && discountPercent !== null && discountPercent !== "") {
      const pct = Number(discountPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return NextResponse.json(
          { success: false, error: "Discount percent must be between 0 and 100." },
          { status: 400 }
        );
      }
      discountPct = round2(pct);
      discountAmount = round2((subtotal * discountPct) / 100);
    } else {
      discountAmount = round2(Number(discount) || 0);
      discountPct = subtotal > 0 ? round2((discountAmount / subtotal) * 100) : 0;
    }
    if (discountAmount < 0 || discountAmount > subtotal) {
      return NextResponse.json(
        { success: false, error: "Discount cannot exceed the sale subtotal." },
        { status: 400 }
      );
    }
    const total = round2(subtotal - discountAmount);
    if (total <= 0) {
      return NextResponse.json(
        { success: false, error: "Credit total must be greater than zero." },
        { status: 400 }
      );
    }
    if (depositAmount - total > SETTLED_EPSILON) {
      return NextResponse.json(
        { success: false, error: `Deposit GH₵${depositAmount.toFixed(2)} exceeds the credit total GH₵${total.toFixed(2)}.` },
        { status: 400 }
      );
    }
    const cogs = lineItems.reduce((acc: number, li: any) => acc + (li.costTotal || 0), 0);
    const grossProfit = round2(total - cogs);

    // 3. Deduct stock — goods leave the shelf at sale time, like a paid sale.
    for (const update of inventoryUpdates) {
      await db
        .update(inventoryItems)
        .set({ quantity: update.newQty, status: update.newStatus })
        .where(eq(inventoryItems.id, update.id));
    }

    // 4. CRM customer (business-isolated) + accrue spend.
    const linkedCustomerId = await linkCustomer(
      Number(businessId),
      cleanName,
      customerPhone ? String(customerPhone).trim() : null,
      total
    );

    // 5. Branch + codes.
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(businessId)));
    const resolvedBranchCode = branchCode || biz?.code || "";
    const resolvedBranchName = biz?.name || "";
    const now = new Date();
    const creditCode = buildCreditCode(biz?.code);
    const initialPaid = Math.min(depositAmount, total);
    const initialBalance = round2(total - initialPaid);
    const settledAtCreate = initialBalance <= SETTLED_EPSILON;

    // 6. Deposit is posted AFTER the credit row exists (step 10) via
    //    postInstallment, then reflected back onto the invoice + tracking.
    const depositTrxId: number | null = null;
    let depositBundle: any = null;

    // 7. CREDIT invoice (flips to PAID when the balance is settled).
    const docNum = `INV-${now.getFullYear()}-${Date.now().toString().slice(-6)}`;
    const [invoice] = await db
      .insert(salesDocuments)
      .values({
        documentNumber: docNum,
        documentType: "INVOICE",
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: cleanName,
        customerPhone: customerPhone || null,
        lineItems,
        subtotalGhs: subtotal,
        discountGhs: discountAmount,
        discountPercent: discountPct,
        totalGhs: total,
        cogsGhs: cogs,
        grossProfitGhs: grossProfit,
        currency: "GHS",
        status: settledAtCreate ? "PAID" : "CREDIT",
        notes: notes || null,
        paymentMethod: "CREDIT",
        linkedTransactionId: depositTrxId,
        createdByUserId: me.id,
        createdByName: me.name,
        createdByRole: me.role,
      })
      .returning();

    // 8. Customer tracking code — the customer's secure order/customer code
    //    shows the order AND the live credit balance on the public /track page.
    const trackCode = await uniqueTrackingCode(biz?.code);
    const [tracking] = await db
      .insert(customerTrackings)
      .values({
        trackingCode: trackCode,
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: cleanName,
        customerPhone: customerPhone || null,
        saleDocumentId: invoice.id,
        transactionId: depositTrxId,
        items: lineItems.map((li: any) => ({
          description: li.description,
          sku: li.sku || null,
          quantity: li.quantity,
          unit: li.unit || null,
          unitPrice: li.unitPrice,
          total: li.total,
        })),
        discountPercent: discountPct,
        discountGhs: discountAmount,
        totalGhs: total,
        currency: "GHS",
        fulfillmentType: "PICKUP",
        status: "RECEIVED",
        statusHistory: [
          {
            status: "RECEIVED",
            at: now.toISOString(),
            by: me.name,
            byRole: me.role,
            note: `Credit sale ${creditCode} opened (${docNum}) — paying in installments${initialPaid > 0 ? `, deposit GH₵${initialPaid.toFixed(2)} received` : ""}.`,
          },
        ],
        orderSource: "SALE",
        paymentChoice: null,
        paymentStatus: settledAtCreate ? "PAID" : "CREDIT",
        paymentMethod: initialPaid > 0 ? depositMethod : null,
        paymentMarkedBy: initialPaid > 0 ? me.name : null,
        paymentMarkedAt: initialPaid > 0 ? now : null,
        stockCommitted: true,
        createdByUserId: me.id,
        createdByName: me.name,
        createdByRole: me.role,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 9. The credit sale row itself.
    const [credit] = await db
      .insert(creditSales)
      .values({
        creditCode,
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: cleanName,
        customerPhone: customerPhone || null,
        trackingId: tracking.id,
        trackingCode: trackCode,
        saleDocumentId: invoice.id,
        items: lineItems.map((li: any) => ({
          description: li.description,
          sku: li.sku || null,
          quantity: li.quantity,
          unit: li.unit || null,
          unitPrice: li.unitPrice,
          total: li.total,
        })),
        subtotalGhs: subtotal,
        discountPercent: discountPct,
        discountGhs: discountAmount,
        totalGhs: total,
        amountPaidGhs: 0, // deposit recorded via postInstallment below
        balanceGhs: total,
        status: "ACTIVE",
        dueDate: dueDate || null,
        notes: notes || null,
        createdByUserId: me.id,
        createdByName: me.name,
        createdByRole: me.role,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 10. Deposit = first installment (posts Finance + Receipt + updates the row).
    let finalCredit = credit;
    if (initialPaid > 0) {
      depositBundle = await postInstallment({
        credit,
        amount: initialPaid,
        paymentMethod: depositMethod,
        reference: depositReference,
        note: "Opening deposit",
        receivedByUserId: me.id,
        receivedByName: me.name,
        receivedByRole: me.role,
        descriptionTag: "Credit Deposit",
      });
      finalCredit = depositBundle.creditSale;
      // reflect the deposit transaction on the tracking + invoice chain
      await db
        .update(customerTrackings)
        .set({ transactionId: depositBundle.transaction.id })
        .where(eq(customerTrackings.id, tracking.id));
      await db
        .update(salesDocuments)
        .set({ linkedTransactionId: depositBundle.transaction.id })
        .where(eq(salesDocuments.id, invoice.id));
    }

    return NextResponse.json({
      success: true,
      creditSale: finalCredit,
      invoice,
      trackingCode: trackCode,
      trackUrl: `/track?code=${encodeURIComponent(trackCode)}`,
      deposit: depositBundle
        ? {
            payment: depositBundle.payment,
            transaction: depositBundle.transaction,
            receipt: depositBundle.receipt,
          }
        : null,
      cogsGhs: cogs,
      grossProfitGhs: grossProfit,
      inventoryUpdates: inventoryUpdates.map((u) => ({
        inventoryId: u.id,
        newQuantity: u.newQty,
        newStatus: u.newStatus,
      })),
    });
  } catch (error: any) {
    console.error("POST /api/credit-sales error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
