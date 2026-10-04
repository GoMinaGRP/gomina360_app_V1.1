import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  hardwareOrders,
  hardwarePurchases,
  hardwareDeliveries,
  inventoryItems,
  businesses,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { applyStockChange, computeStockStatus, stockRefusal } from "@/lib/stock";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { notifyPurchase, ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";
import { postOrGateExpenseTransaction } from "@/lib/expensePosting";
import { postSale } from "@/lib/salePosting";
import { linkOrCreateCustomer } from "@/lib/customerLink";
import { linkSupplier } from "@/lib/supplierLinks";

/**
 * Hardware & Building Materials store API.
 * Same linkage contract as the other business-type APIs:
 *   • ORDER delivered     → stock OUT + INCOME transaction (Finance/Dashboards)
 *   • PURCHASE received   → stock IN  + EXPENSE transaction
 *   • DELIVERY completed  → stock OUT (standalone dispatches only; an
 *     order-linked delivery inherits the order's own fulfilment, so stock
 *     is NEVER deducted twice)
 * All endpoints require a valid session (same access control as every
 * other module route).
 */

/**
 * Order delivered → the SHARED sale engine.
 *
 * Hardware used to hand-roll `insert(transactions)` here, so its revenue
 * never produced a receipt, never touched the CRM and never appeared in
 * Order & Tracking — the audit's "second sales pipeline". It now posts
 * through `postSale()` (ledger + receipt + CRM + tracking), keeping the
 * module's own ledger category and wording so Finance reads exactly as
 * before, and adds the two facts that were missing.
 */
async function bookOrderSale(
  order: any,
  actorName?: string | null,
  actorRole?: string | null,
  actorUserId?: number | null,
  paymentMethod?: string | null
) {
  const qty = Number(order.quantity) || 0;
  const unitPrice = Number(order.unitPriceGhs) || 0;
  const lineTotal = Math.round(qty * unitPrice * 100) / 100;
  const amount = Number(order.totalGhs) || lineTotal;
  const discount = Math.max(0, Math.round((lineTotal - amount) * 100) / 100);
  const [inv] = order.inventoryId
    ? await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(order.inventoryId)))
    : [null];
  return postSale({
    businessId: order.businessId,
    branchCode: order.branchCode,
    lines: [
      {
        inventoryId: order.inventoryId ? Number(order.inventoryId) : null,
        sku: inv?.sku ?? null,
        description: `${order.itemName} (${order.orderNumber})`,
        quantity: qty,
        unit: inv?.unit ?? "Units",
        category: inv?.category ?? null,
        unitPrice,
        costPrice: Number(inv?.costPriceGhs) || 0,
      },
    ],
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerId: order.customerId ?? null,
    paymentMethod: paymentMethod || "CASH",
    category: "HARDWARE_ORDER_SALE",
    description: `Order ${order.orderNumber} delivered: ${qty}× ${order.itemName} — ${order.customerName}`,
    discount,
    actor: { name: actorName || "Hardware Store", role: actorRole || null, id: actorUserId ?? null },
  });
}

async function bookExpense(
  businessId: number,
  branchCode: string | null,
  branchName: string | null,
  amount: number,
  category: string,
  description: string,
  paymentMethod: string,
  actorName?: string | null,
  actorRole?: string | null,
  actorUserId?: number | null,
  actorObj?: any
) {
  const actor = actorObj || {
    id: actorUserId ? Number(actorUserId) : null,
    name: actorName || "Hardware Store",
    role: actorRole || null,
  };
  return postOrGateExpenseTransaction({
    businessId,
    branchCode,
    branchName,
    category,
    amountGhs: amount,
    paymentMethod: paymentMethod || "BANK_TRANSFER",
    description,
    actor,
    targetLabel: `${category} — GH₵ ${Number(amount).toFixed(2)}`,
    metadata: { source: "HARDWARE_STORE" },
  });
}

/**
 * Deduct quantity from a stock item (never below zero), refreshing its status.
 * Returns the refusal message when the item is a variant product that this
 * flow cannot price per combination yet — the caller surfaces it instead of
 * silently delivering without a deduction.
 */
async function stockOutItem(inventoryId: number, qty: number): Promise<string | null> {
  const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
  if (!inv) return null;
  // P5: ONE stock writer (clamps at zero, logs the movement).
  const applied = await applyStockChange({
    businessId: inv.businessId,
    inventoryId: inv.id,
    delta: -qty,
    reason: "SALE",
    refType: "HARDWARE_DELIVERY",
  });
  return stockRefusal(applied);
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    // Scope gate: orders, purchases and yard dispatches stay inside the
    // caller's accessible businesses.
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const [orders, purchases, deliveries] = await Promise.all([
      db.select().from(hardwareOrders).where(eq(hardwareOrders.businessId, businessId)),
      db.select().from(hardwarePurchases).where(eq(hardwarePurchases.businessId, businessId)),
      db.select().from(hardwareDeliveries).where(eq(hardwareDeliveries.businessId, businessId)),
    ]);
    const descId = (a: any, b: any) => (b.id || 0) - (a.id || 0);
    return NextResponse.json({
      success: true,
      orders: orders.sort(descId),
      purchases: purchases.sort(descId),
      deliveries: deliveries.sort(descId),
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    // Mutations (orders, purchases, deliveries) change stock, finance and
    // dashboard payloads — drop the shared /api/init snapshot cache so the
    // UI's post-save refresh reads fresh data instead of a ≤2.5 s stale copy.
    ttlInvalidate("init");
    const body = await request.json();
    const { entity, data } = body;
    const businessId = Number(data?.businessId);
    if (!entity || !businessId) {
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
    }
    const branchCode = data.branchCode || biz.code || null;
    const today = new Date().toISOString().split("T")[0];
    const stamp = Date.now().toString().slice(-5);

    // ── ORDER: customer material order with fulfilment pipeline ──────
    if (entity === "ORDER") {
      const qty = Math.max(0.5, Number(data.quantity) || 1);
      const price = Number(data.unitPriceGhs) || 0;
      // Link the buyer into the shared CRM at order time (one record per
      // phone/name) so the order, the receipt and the customer directory
      // all point at the same person.
      const buyer = await linkOrCreateCustomer({
        businessId,
        name: data.customerName,
        phone: data.customerPhone,
        amount: 0,
        loyaltyPoints: 0,
        phoneFallback: "—",
      });
      const [row] = await db
        .insert(hardwareOrders)
        .values({
          businessId,
          branchCode,
          orderNumber: data.orderNumber || `ORD-HW-${new Date().getFullYear()}-${stamp}`,
          customerName: data.customerName || "Walk-in Customer",
          customerPhone: data.customerPhone || null,
          customerId: buyer?.id ?? null,
          itemName: data.itemName || "Hardware Materials",
          inventoryId: data.inventoryId ? Number(data.inventoryId) : null,
          quantity: qty,
          unitPriceGhs: price,
          totalGhs: Number(data.totalGhs) || qty * price,
          status: ["PENDING", "READY", "DELIVERED", "CANCELLED"].includes(data.status) ? data.status : "PENDING",
          dueDate: data.dueDate || null,
          deliverySite: data.deliverySite || null,
          notes: data.notes || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── PURCHASE: supplier restock; RECEIVED flows into Inventory + Finance ──
    if (entity === "PURCHASE") {
      const qty = Math.max(0.5, Number(data.quantity) || 1);
      const cost = Number(data.unitCostGhs) || 0;
      const status = ["ORDERED", "RECEIVED", "CANCELLED"].includes(data.status) ? data.status : "ORDERED";
      const [row] = await db
        .insert(hardwarePurchases)
        .values({
          businessId,
          branchCode,
          purchaseNumber: data.purchaseNumber || `PO-HW-${new Date().getFullYear()}-${stamp}`,
          supplierName: data.supplierName || "Supplier",
          itemName: data.itemName || "Building Material",
          quantity: qty,
          unitCostGhs: cost,
          totalGhs: qty * cost,
          status,
          orderDate: data.orderDate || today,
          receivedDate: status === "RECEIVED" ? data.receivedDate || today : data.receivedDate || null,
          notes: data.notes || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();

      // Bell: tell the branch team + owner about the recorded purchase.
      await notifyPurchase({
        businessId,
        branchCode,
        purchaseNumber: row.purchaseNumber,
        supplierName: row.supplierName,
        itemName: row.itemName,
        quantity: row.quantity,
        totalGhs: row.totalGhs,
        status: row.status,
        recordId: row.id,
        actorName: data.createdByName || null,
      });

      if (status === "RECEIVED") {
        const refusal = await applyPurchaseReceipt(row, data, biz);
        if (refusal) return NextResponse.json({ success: false, error: refusal }, { status: 400 });
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── DELIVERY: site dispatch record; completed standalone deliveries stock-out ──
    if (entity === "DELIVERY") {
      const qty = Math.max(0.5, Number(data.quantity) || 1);
      const [row] = await db
        .insert(hardwareDeliveries)
        .values({
          businessId,
          branchCode,
          deliveryNumber: data.deliveryNumber || `DLV-HW-${new Date().getFullYear()}-${stamp}`,
          orderNumber: data.orderNumber || null,
          customerName: data.customerName || "Site Customer",
          siteAddress: data.siteAddress || null,
          driverName: data.driverName || null,
          vehicleNumber: data.vehicleNumber || null,
          itemName: data.itemName || "Building Materials",
          inventoryId: data.inventoryId ? Number(data.inventoryId) : null,
          quantity: qty,
          unit: data.unit || "Units",
          status: ["SCHEDULED", "EN_ROUTE", "DELIVERED", "CANCELLED"].includes(data.status) ? data.status : "SCHEDULED",
          dispatchDate: data.dispatchDate || today,
          notes: data.notes || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * Stock-in for a received supplier purchase + expense booking (shared by
 * POST/PATCH). Returns a refusal message when the target item is a variant
 * product that needs a size/colour choice — the caller answers 400 with it
 * instead of booking a receipt that moved no stock.
 */
async function applyPurchaseReceipt(purchase: any, data: any, biz: any): Promise<string | null> {
  const qty = Number(purchase.quantity) || 0;
  const cost = Number(purchase.unitCostGhs) || 0;
  if (qty <= 0) return null;

  // Match an inventory item by explicit id, then by name prefix; create if absent.
  const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, purchase.businessId));
  let target = data.inventoryId ? inv.find((i: any) => i.id === Number(data.inventoryId)) : undefined;
  if (!target) {
    const key = String(purchase.itemName || "").toUpperCase().slice(0, 12);
    target = inv.find(
      (i: any) =>
        i.name?.toUpperCase().includes(key) ||
        key.includes(String(i.name || "").toUpperCase().slice(0, 12))
    );
  }
  if (target) {
    const applied = await applyStockChange({
      businessId: purchase.businessId,
      inventoryId: target.id,
      delta: qty,
      reason: "PURCHASE",
      refType: "HARDWARE_PURCHASE",
      refId: Number(data.id) || null,
      note: purchase.itemName ? `Purchase: ${purchase.itemName}` : null,
      setCostPriceGhs: cost,
    });
    const refusal = stockRefusal(applied);
    if (refusal) return refusal;
  } else {
    const taken = new Set(
      (await db.select({ sku: inventoryItems.sku }).from(inventoryItems)).map((r: any) => r.sku)
    );
    let sku = `HW-${String(purchase.itemName || "ITEM").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18)}`;
    let n = 2;
    while (taken.has(sku)) sku = `${sku.slice(0, 20)}-${n++}`;
    // Created EMPTY, then stocked through the one writer so the opening
    // quantity is a logged movement too.
    const [created] = await db.insert(inventoryItems).values({
      name: purchase.itemName,
      sku,
      businessId: purchase.businessId,
      category: "Building Materials",
      quantity: 0,
      unit: data.unit || "Units",
      costPriceGhs: cost,
      sellingPriceGhs: Number(data.sellingPriceGhs) || Math.round(cost * 1.25 * 100) / 100,
      minStockThreshold: 10,
      status: "OUT_OF_STOCK",
    }).returning();
    await applyStockChange({
      businessId: purchase.businessId,
      inventoryId: created.id,
      delta: qty,
      reason: "OPENING",
      refType: "HARDWARE_PURCHASE",
      note: `Opening stock: ${purchase.itemName}`,
      setCostPriceGhs: cost,
    });
  }

  // Supplier ledger link (feed-mill pattern, shared via supplierLinks): naming
  // a vendor on a received purchase creates/refreshes that supplier org-wide so
  // the shared Suppliers module stops reading zero for this unit's vendors.
  if (purchase.supplierName && qty * cost > 0) {
    const orgId = await ownerOrgOfBusiness(purchase.businessId).catch(() => null);
    const linked = await linkSupplier({
      ownerId: orgId ?? (biz as any)?.ownerId ?? null,
      name: purchase.supplierName,
      category: "Building Materials",
      suppliedGhs: qty * cost,
      paymentMethod: data.paymentMethod,
      logTag: "[hardware]",
    });
    if (linked?.supplier?.id && purchase.id) {
      await db
        .update(hardwarePurchases)
        .set({ supplierId: linked.supplier.id })
        .where(eq(hardwarePurchases.id, Number(purchase.id)))
        .catch(() => {});
    }
  }

  if (data.recordExpense !== false && qty * cost > 0) {
    await bookExpense(
      purchase.businessId,
      purchase.branchCode,
      biz?.name || null,
      qty * cost,
      "Stock Purchase (Hardware)",
      `Purchase ${purchase.purchaseNumber} — ${qty} x ${purchase.itemName} from ${purchase.supplierName}`,
      data.paymentMethod || "BANK_TRANSFER",
      data.createdByName || purchase.createdByName,
      data.createdByRole || purchase.createdByRole,
      data.createdByUserId
    );
  }

  return null;
}

export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    // Status progressions re-shape stock + finance + dashboards — see POST.
    ttlInvalidate("init");
    const body = await request.json();
    const { entity, id, data } = body;
    if (!entity || !id) {
      return NextResponse.json({ success: false, error: "entity and id required" }, { status: 400 });
    }
    const today = new Date().toISOString().split("T")[0];

    // ── ORDER status progression; DELIVERED finalises the sale exactly once ──
    if (entity === "ORDER") {
      const [before] = await db.select().from(hardwareOrders).where(eq(hardwareOrders.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, before.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(hardwareOrders)
        .set({
          status: data?.status || undefined,
          readyAt: data?.status === "READY" && before.status !== "READY" ? today : undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(hardwareOrders.id, Number(id)))
        .returning();
      let stockWarning: string | null = null;
      if (row.status === "DELIVERED" && before?.status !== "DELIVERED" && !row.fulfilledDate) {
        if (row.inventoryId) stockWarning = await stockOutItem(Number(row.inventoryId), Number(row.quantity) || 0);
        // One writer for money: ledger + receipt + CRM + tracking.
        const posted = await bookOrderSale(
          row,
          data?.actorName || row.createdByName,
          data?.actorRole || row.createdByRole,
          data?.createdByUserId,
          data?.paymentMethod
        );
        if (posted.success) {
          await db
            .update(hardwareOrders)
            .set({ customerId: posted.customerId ?? row.customerId ?? null })
            .where(eq(hardwareOrders.id, row.id));
          row.customerId = posted.customerId ?? row.customerId;
        }
        await db.update(hardwareOrders).set({ fulfilledDate: today }).where(eq(hardwareOrders.id, row.id));
        row.fulfilledDate = today;
      }
      return NextResponse.json({ success: true, item: row, ...(stockWarning ? { stockWarning } : {}) });
    }

    // ── PURCHASE: ORDERED → RECEIVED applies stock-in + expense exactly once ──
    if (entity === "PURCHASE") {
      const [before] = await db.select().from(hardwarePurchases).where(eq(hardwarePurchases.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Purchase not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, before.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(hardwarePurchases)
        .set({
          status: data?.status || undefined,
          receivedDate: data?.status === "RECEIVED" ? before.receivedDate || today : undefined,
        })
        .where(eq(hardwarePurchases.id, Number(id)))
        .returning();
      if (row.status === "RECEIVED" && before?.status !== "RECEIVED") {
        const [biz] = await db.select().from(businesses).where(eq(businesses.id, row.businessId));
        const refusal = await applyPurchaseReceipt(row, { ...data, inventoryId: data?.inventoryId }, biz);
        if (refusal) return NextResponse.json({ success: false, error: refusal }, { status: 400 });
        await notifyPurchase({
          businessId: row.businessId,
          branchCode: row.branchCode,
          purchaseNumber: row.purchaseNumber,
          supplierName: row.supplierName,
          itemName: row.itemName,
          quantity: row.quantity,
          totalGhs: row.totalGhs,
          status: "RECEIVED",
          recordId: row.id,
          actorName: data?.createdByName || null,
          type: "PURCHASE_RECEIVED",
        });
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── DELIVERY status progression; standalone completions deduct stock ──
    if (entity === "DELIVERY") {
      const [before] = await db.select().from(hardwareDeliveries).where(eq(hardwareDeliveries.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Delivery not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, before.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(hardwareDeliveries)
        .set({
          status: data?.status || undefined,
          enRouteAt: data?.status === "EN_ROUTE" && before.status !== "EN_ROUTE" ? today : undefined,
          deliveredDate: data?.status === "DELIVERED" ? today : undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(hardwareDeliveries.id, Number(id)))
        .returning();
      let stockWarning: string | null = null;
      if (row.status === "DELIVERED" && before?.status !== "DELIVERED" && row.inventoryId && !row.orderNumber) {
        // Standalone dispatch (not linked to a fulfilled order): deduct stock here.
        stockWarning = await stockOutItem(Number(row.inventoryId), Number(row.quantity) || 0);
      }
      return NextResponse.json({ success: true, item: row, ...(stockWarning ? { stockWarning } : {}) });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}
