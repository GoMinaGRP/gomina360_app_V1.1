import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, inventoryItems, salesDocuments, businesses, customers, customerTrackings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { buildTrackingCode } from "@/lib/tracking";

/**
 * POST /api/sales
 *
 * Inventory-linked sale processor:
 * 1. Validates every cart item against branch inventory (stock check)
 * 2. Deducts sold quantities from inventory
 * 3. Updates inventory status (IN_STOCK / LOW_STOCK / OUT_OF_STOCK)
 * 4. Creates a financial transaction record
 * 5. Creates a sales document (receipt) with line items
 * 6. Records any custom price overrides for audit
 *
 * Body: {
 *   businessId, branchCode,
 *   customerName, customerPhone,
 *   paymentMethod,
 *   cartItems: [{ inventoryId, sku, name, quantity, originalPrice, sellingPrice, customPriceReason? }],
 *   notes,
 *   createdByUserId, createdByName, createdByRole,
 *   discount?
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      businessId,
      branchCode,
      customerName,
      customerPhone,
      paymentMethod,
      cartItems,
      notes,
      createdByUserId,
      createdByName,
      createdByRole,
      discount,
      discountPercent,
    } = body;

    if (!businessId || !cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json(
        { success: false, error: "businessId and at least one cart item are required." },
        { status: 400 }
      );
    }

    // ── 1. Validate every item against inventory ──────────────────────
    const validationErrors: string[] = [];
    const inventoryUpdates: { id: number; newQty: number; newStatus: string }[] = [];
    const lineItems: any[] = [];
    const priceAuditEntries: any[] = [];

    for (const item of cartItems) {
      const { inventoryId, quantity, sellingPrice, originalPrice, customPriceReason } = item;

      if (!inventoryId || !quantity || quantity <= 0) {
        validationErrors.push(`Invalid cart item: missing inventoryId or quantity.`);
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
        validationErrors.push(`"${inv.name}" is OUT OF STOCK and cannot be sold.`);
        continue;
      }

      if (Number(quantity) > inv.quantity) {
        validationErrors.push(
          `Insufficient stock for "${inv.name}": requested ${quantity}, available ${inv.quantity} ${inv.unit}.`
        );
        continue;
      }

      const effectivePrice = Number(sellingPrice) || inv.sellingPriceGhs;
      const itemTotal = effectivePrice * Number(quantity);
      const newQty = inv.quantity - Number(quantity);
      const newStatus =
        newQty <= 0
          ? "OUT_OF_STOCK"
          : newQty <= inv.minStockThreshold
          ? "LOW_STOCK"
          : "IN_STOCK";

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

      // Track price overrides for audit
      if (effectivePrice !== inv.sellingPriceGhs) {
        priceAuditEntries.push({
          inventoryId: inv.id,
          sku: inv.sku,
          name: inv.name,
          originalPrice: inv.sellingPriceGhs,
          customPrice: effectivePrice,
          difference: effectivePrice - inv.sellingPriceGhs,
          reason: customPriceReason || "No reason provided",
          changedBy: createdByName || "Unknown",
          changedByRole: createdByRole || "Staff",
        });
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: validationErrors.join(" | "), errors: validationErrors },
        { status: 400 }
      );
    }

    // ── 2. Deduct inventory quantities ───────────────────────────────
    for (const update of inventoryUpdates) {
      await db
        .update(inventoryItems)
        .set({ quantity: update.newQty, status: update.newStatus })
        .where(eq(inventoryItems.id, update.id));
    }

    // ── 3. Calculate totals ──────────────────────────────────────────
    const subtotal = lineItems.reduce((acc: number, li: any) => acc + li.total, 0);
    // Percentage discount is the primary mode (auto-calculates the amount);
    // a flat GH₵ amount stays supported for backward compatibility.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    let discountPct = 0;
    let discountAmount = 0;
    if (discountPercent !== undefined && discountPercent !== null && discountPercent !== "") {
      const pct = Number(discountPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return NextResponse.json(
          { success: false, error: "Discount percent must be between 0 and 100." },
          { status: 400 },
        );
      }
      discountPct = r2(pct);
      discountAmount = r2((subtotal * discountPct) / 100);
    } else {
      discountAmount = r2(Number(discount) || 0);
      discountPct = subtotal > 0 ? r2((discountAmount / subtotal) * 100) : 0;
    }
    if (discountAmount < 0 || discountAmount > subtotal) {
      return NextResponse.json(
        { success: false, error: "Discount cannot exceed the sale subtotal." },
        { status: 400 },
      );
    }
    const total = r2(subtotal - discountAmount);
    // Cost of goods sold (inventory cost × qty) → real profit per sale
    const cogs = lineItems.reduce((acc: number, li: any) => acc + (li.costTotal || 0), 0);
    const grossProfit = total - cogs;

    // ── 3b. Link / accumulate the customer record (shared CRM) ──────
    let linkedCustomerId: number | null = null;
    try {
      const allCustomers = await db.select().from(customers);
      const norm = (s: any) => String(s || "").trim().toLowerCase();
      // Business-isolated CRM: prefer a match ALREADY belonging to this
      // business, then fall back to legacy group-shared rows (null); brand
      // new customers are stamped to THIS unit so a new business never
      // inherits another's clientele.
      const belongs = (c: any) => c.businessId === Number(businessId);
      const shared = (c: any) => c.businessId === null;
      const cust =
        (customerPhone && allCustomers.find((c) => norm(c.phone) === norm(customerPhone) && belongs(c))) ||
        (customerName && allCustomers.find((c) => norm(c.name) === norm(customerName) && belongs(c))) ||
        (customerPhone && allCustomers.find((c) => norm(c.phone) === norm(customerPhone) && shared(c))) ||
        (customerName && allCustomers.find((c) => norm(c.name) === norm(customerName) && shared(c))) ||
        null;
      if (cust) {
        linkedCustomerId = cust.id;
        await db
          .update(customers)
          .set({
            totalSpentGhs: (cust.totalSpentGhs || 0) + total,
            loyaltyPoints: (cust.loyaltyPoints || 0) + Math.floor(total / 100),
          })
          .where(eq(customers.id, cust.id));
      } else if (customerName && String(customerName).trim() && norm(customerName) !== "walk-in" && norm(customerName) !== "walk-in customer") {
        const [created] = await db
          .insert(customers)
          .values({
            name: String(customerName).trim(),
            type: "RETAIL",
            // phone is NOT NULL in the schema — store "" when the sale has no
            // number so walk-in customers still get a CRM record
            phone: customerPhone || "",
            totalSpentGhs: total,
            loyaltyPoints: Math.floor(total / 100),
            businessId: Number(businessId),
          })
          .returning();
        linkedCustomerId = created?.id ?? null;
      }
    } catch (custErr) {
      console.error("/api/sales customer link warning:", custErr);
    }

    // ── 4. Get branch info ───────────────────────────────────────────
    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, Number(businessId)));
    const resolvedBranchCode = branchCode || biz?.code || "";
    const resolvedBranchName = biz?.name || "";

    // ── 5. Create financial transaction ──────────────────────────────
    const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toISOString().split("T")[0];

    const lineDesc = lineItems
      .map((li: any) => `${li.quantity}× ${li.description}`)
      .join(", ");

    const [newTrx] = await db
      .insert(transactions)
      .values({
        transactionNumber: trxNum,
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        type: "INCOME",
        category: "Inventory Sale",
        amountGhs: total,
        paymentMethod: paymentMethod || "CASH",
        customerId: linkedCustomerId,
        description: `[INV:${trxNum}] ${lineDesc} — ${customerName || "Walk-in"}${discountAmount > 0 ? ` · ${discountPct}% discount −GH₵${discountAmount.toFixed(2)}` : ""}`,
        date: dateStr,
        createdAt: new Date(),
        status: "COMPLETED",
        recordedBy: createdByName || "Sales Center",
        recordedByRole: createdByRole || null,
        recordedByUserId: createdByUserId ? Number(createdByUserId) : null,
      })
      .returning();

    // ── 6. Create receipt sales document ─────────────────────────────
    const docNum = `RCP-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;

    const [newDoc] = await db
      .insert(salesDocuments)
      .values({
        documentNumber: docNum,
        documentType: "RECEIPT",
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: customerName || "Walk-in Customer",
        customerPhone: customerPhone || null,
        lineItems,
        subtotalGhs: subtotal,
        discountGhs: discountAmount,
        discountPercent: discountPct,
        totalGhs: total,
        cogsGhs: cogs,
        grossProfitGhs: grossProfit,
        currency: "GHS",
        status: "PAID",
        notes: notes || null,
        paymentMethod: paymentMethod || "CASH",
        linkedTransactionId: newTrx.id,
        createdByUserId: createdByUserId ? Number(createdByUserId) : null,
        createdByName: createdByName || "Sales Center",
        createdByRole: createdByRole || null,
      })
      .returning();

    // ── 7. Auto-mint a customer tracking code for this order ─────────
    // Every sale/order gets a unique GM-* code the customer can follow on
    // the public /track page without logging in. Wrapped so a tracking
    // hiccup can never break a sale.
    let trackingCode: string | null = null;
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
      const now2 = new Date();
      await db.insert(customerTrackings).values({
        trackingCode: code,
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        customerId: linkedCustomerId,
        customerName: customerName || "Walk-in Customer",
        customerPhone: customerPhone || null,
        saleDocumentId: newDoc.id,
        transactionId: newTrx.id,
        items: lineItems.map((li: any) => ({
          description: li.description,
          sku: li.sku || null,
          quantity: li.quantity,
          unit: li.unit || null,
          unitPrice: li.unitPrice,
          total: li.total,
        })),
        totalGhs: total,
        currency: "GHS",
        fulfillmentType: "PICKUP",
        status: "RECEIVED",
        statusHistory: [
          {
            status: "RECEIVED",
            at: now2.toISOString(),
            by: createdByName || "Sales Center",
            byRole: createdByRole || "WORKER",
            note: `Sale recorded (${docNum}). Order registered for customer tracking.`,
          },
        ],
        orderSource: "SALE",
        paymentChoice: null,
        paymentStatus: "PAID",
        paymentMethod: paymentMethod || "CASH",
        paymentMarkedBy: createdByName || "Sales Center",
        paymentMarkedAt: now2,
        stockCommitted: true,
        createdByUserId: createdByUserId ? Number(createdByUserId) : null,
        createdByName: createdByName || "Sales Center",
        createdByRole: createdByRole || null,
        createdAt: now2,
        updatedAt: now2,
      });
      trackingCode = code;
    } catch (trackErr) {
      console.error("/api/sales tracking warning:", trackErr);
    }

    return NextResponse.json({
      success: true,
      transaction: newTrx,
      receipt: newDoc,
      lineItems,
      cogsGhs: cogs,
      grossProfitGhs: grossProfit,
      customerId: linkedCustomerId,
      trackingCode,
      trackUrl: trackingCode ? `/track?code=${encodeURIComponent(trackingCode)}` : null,
      priceOverrides: priceAuditEntries,
      inventoryUpdates: inventoryUpdates.map((u) => ({
        inventoryId: u.id,
        newQuantity: u.newQty,
        newStatus: u.newStatus,
      })),
    });
  } catch (error: any) {
    console.error("POST /api/sales error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
