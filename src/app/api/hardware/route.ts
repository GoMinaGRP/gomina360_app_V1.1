import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  hardwareOrders,
  hardwarePurchases,
  hardwareDeliveries,
  inventoryItems,
  transactions,
  businesses,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { notifyPurchase } from "@/lib/notify";

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

async function bookRevenue(
  businessId: number,
  branchCode: string | null,
  branchName: string | null,
  amount: number,
  category: string,
  description: string,
  actorName?: string | null,
  actorRole?: string | null
) {
  const now = new Date();
  await db.insert(transactions).values({
    transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`,
    businessId,
    branchCode,
    branchName,
    type: "INCOME",
    category,
    amountGhs: amount,
    paymentMethod: "CASH",
    description,
    date: now.toISOString().split("T")[0],
    createdAt: new Date(),
    status: "COMPLETED",
    recordedBy: actorName || "Hardware Store",
    recordedByRole: actorRole || null,
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
  actorUserId?: number | null
) {
  const now = new Date();
  await db.insert(transactions).values({
    transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`,
    businessId,
    branchCode,
    branchName,
    type: "EXPENSE",
    category,
    amountGhs: amount,
    paymentMethod: paymentMethod || "BANK_TRANSFER",
    description,
    date: now.toISOString().split("T")[0],
    createdAt: new Date(),
    status: "COMPLETED",
    recordedBy: actorName || "Hardware Store",
    recordedByRole: actorRole || null,
    recordedByUserId: actorUserId ? Number(actorUserId) : null,
  });
}

/** Deduct quantity from a stock item (never below zero), refreshing its status. */
async function stockOutItem(inventoryId: number, qty: number) {
  const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
  if (!inv) return;
  const newQty = Math.max(0, (inv.quantity || 0) - qty);
  await db
    .update(inventoryItems)
    .set({ quantity: newQty, status: computeStockStatus(newQty, inv.minStockThreshold || 0) })
    .where(eq(inventoryItems.id, inv.id));
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, data } = body;
    const businessId = Number(data?.businessId);
    if (!entity || !businessId) {
      return NextResponse.json({ success: false, error: "entity and businessId required" }, { status: 400 });
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
      const [row] = await db
        .insert(hardwareOrders)
        .values({
          businessId,
          branchCode,
          orderNumber: data.orderNumber || `ORD-HW-${new Date().getFullYear()}-${stamp}`,
          customerName: data.customerName || "Walk-in Customer",
          customerPhone: data.customerPhone || null,
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
        await applyPurchaseReceipt(row, data, biz);
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** Stock-in for a received supplier purchase + expense booking (shared by POST/PATCH). */
async function applyPurchaseReceipt(purchase: any, data: any, biz: any) {
  const qty = Number(purchase.quantity) || 0;
  const cost = Number(purchase.unitCostGhs) || 0;
  if (qty <= 0) return;

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
    const newQty = (target.quantity || 0) + qty;
    await db
      .update(inventoryItems)
      .set({
        quantity: newQty,
        costPriceGhs: cost || target.costPriceGhs,
        status: computeStockStatus(newQty, target.minStockThreshold || 0),
      })
      .where(eq(inventoryItems.id, target.id));
  } else {
    const taken = new Set(
      (await db.select({ sku: inventoryItems.sku }).from(inventoryItems)).map((r: any) => r.sku)
    );
    let sku = `HW-${String(purchase.itemName || "ITEM").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18)}`;
    let n = 2;
    while (taken.has(sku)) sku = `${sku.slice(0, 20)}-${n++}`;
    await db.insert(inventoryItems).values({
      name: purchase.itemName,
      sku,
      businessId: purchase.businessId,
      category: "Building Materials",
      quantity: qty,
      unit: data.unit || "Units",
      costPriceGhs: cost,
      sellingPriceGhs: Number(data.sellingPriceGhs) || Math.round(cost * 1.25 * 100) / 100,
      minStockThreshold: 10,
      status: computeStockStatus(qty, 10),
    });
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
}

export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
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
      const [row] = await db
        .update(hardwareOrders)
        .set({
          status: data?.status || undefined,
          readyAt: data?.status === "READY" && before.status !== "READY" ? today : undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(hardwareOrders.id, Number(id)))
        .returning();
      if (row.status === "DELIVERED" && before?.status !== "DELIVERED" && !row.fulfilledDate) {
        if (row.inventoryId) await stockOutItem(Number(row.inventoryId), Number(row.quantity) || 0);
        const [biz] = await db.select().from(businesses).where(eq(businesses.id, row.businessId));
        await bookRevenue(
          row.businessId,
          row.branchCode,
          biz?.name || null,
          row.totalGhs || (Number(row.quantity) || 0) * (row.unitPriceGhs || 0),
          "HARDWARE_ORDER_SALE",
          `Order ${row.orderNumber} delivered: ${row.quantity}× ${row.itemName} — ${row.customerName}`,
          data?.actorName || row.createdByName,
          data?.actorRole || row.createdByRole
        );
        await db.update(hardwareOrders).set({ fulfilledDate: today }).where(eq(hardwareOrders.id, row.id));
        row.fulfilledDate = today;
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── PURCHASE: ORDERED → RECEIVED applies stock-in + expense exactly once ──
    if (entity === "PURCHASE") {
      const [before] = await db.select().from(hardwarePurchases).where(eq(hardwarePurchases.id, Number(id)));
      if (!before) return NextResponse.json({ success: false, error: "Purchase not found" }, { status: 404 });
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
        await applyPurchaseReceipt(row, { ...data, inventoryId: data?.inventoryId }, biz);
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
      if (row.status === "DELIVERED" && before?.status !== "DELIVERED" && row.inventoryId && !row.orderNumber) {
        // Standalone dispatch (not linked to a fulfilled order): deduct stock here.
        await stockOutItem(Number(row.inventoryId), Number(row.quantity) || 0);
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
