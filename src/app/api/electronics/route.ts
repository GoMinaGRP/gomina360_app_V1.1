import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  electronicsOrders,
  electronicsSerials,
  electronicsWarranties,
  electronicsPurchases,
  inventoryItems,
  transactions,
  businesses,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { notifyPurchase } from "@/lib/notify";

/**
 * Complete a delivered electronics order as a real sale:
 * deduct the stock, record the INCOME transaction, and mark the matching
 * in-stock serials SOLD for the customer. Idempotent via fulfilledDate.
 */
async function fulfillElectronicsOrder(order: any, businessId: number, branchCode: string | null, actorName?: string | null, actorRole?: string | null) {
  const today = new Date().toISOString().split("T")[0];
  const stamp = Date.now().toString().slice(-5);
  if (order.inventoryId) {
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(order.inventoryId)));
    if (inv) {
      const newQty = Math.max(0, (inv.quantity || 0) - (order.quantity || 0));
      await db
        .update(inventoryItems)
        .set({ quantity: newQty, status: computeStockStatus(newQty, inv.minStockThreshold || 0) })
        .where(eq(inventoryItems.id, inv.id));
    }
    // Mark matching in-stock serials as SOLD to this customer
    const serialRows = await db
      .select()
      .from(electronicsSerials)
      .where(eq(electronicsSerials.inventoryId, Number(order.inventoryId)));
    const toSell = serialRows.filter((s) => s.status === "IN_STOCK").slice(0, order.quantity || 0);
    for (const s of toSell) {
      await db
        .update(electronicsSerials)
        .set({ status: "SOLD", customerName: order.customerName, saleDate: today })
        .where(eq(electronicsSerials.id, s.id));
    }
  }
  // Revenue into Finance so dashboards / reports update
  await db.insert(transactions).values({
    transactionNumber: `TRX-${new Date().getFullYear()}-${stamp}`,
    businessId,
    branchCode,
    branchName: null,
    type: "INCOME",
    category: "ELECTRONICS_ORDER_SALE",
    amountGhs: order.totalGhs || (order.quantity || 0) * (order.unitPriceGhs || 0),
    paymentMethod: "CASH",
    description: `Order ${order.orderNumber} delivered: ${order.quantity}× ${order.itemName} — ${order.customerName}`,
    date: today,
    createdAt: new Date(),
    status: "COMPLETED",
    recordedBy: actorName || "Electronics Shop",
    recordedByRole: actorRole || null,
  });
  await db
    .update(electronicsOrders)
    .set({ fulfilledDate: today })
    .where(eq(electronicsOrders.id, order.id));
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
    const [orders, serials, warranties, purchases] = await Promise.all([
      db.select().from(electronicsOrders).where(eq(electronicsOrders.businessId, businessId)),
      db.select().from(electronicsSerials).where(eq(electronicsSerials.businessId, businessId)),
      db.select().from(electronicsWarranties).where(eq(electronicsWarranties.businessId, businessId)),
      db.select().from(electronicsPurchases).where(eq(electronicsPurchases.businessId, businessId)),
    ]);
    const descId = (a: any, b: any) => (b.id || 0) - (a.id || 0);
    return NextResponse.json({
      success: true,
      orders: orders.sort(descId),
      serials: serials.sort(descId),
      warranties: warranties.sort(descId),
      purchases: purchases.sort(descId),
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
    const branchCode = data.branchCode || biz?.code || null;
    const today = new Date().toISOString().split("T")[0];
    const stamp = Date.now().toString().slice(-5);

    // ── ORDER: customer sales order with fulfillment pipeline ──────────
    if (entity === "ORDER") {
      const qty = Math.max(1, Number(data.quantity) || 1);
      const price = Number(data.unitPriceGhs) || 0;
      const [row] = await db
        .insert(electronicsOrders)
        .values({
          businessId,
          branchCode,
          orderNumber: data.orderNumber || `ORD-TEC-${new Date().getFullYear()}-${stamp}`,
          customerName: data.customerName || "Walk-in Customer",
          customerPhone: data.customerPhone || null,
          itemName: data.itemName || "Electronics Item",
          inventoryId: data.inventoryId ? Number(data.inventoryId) : null,
          quantity: qty,
          unitPriceGhs: price,
          totalGhs: qty * price,
          status: ["PENDING", "READY", "DELIVERED", "CANCELLED"].includes(data.status) ? data.status : "PENDING",
          dueDate: data.dueDate || null,
          notes: data.notes || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      // Orders created straight as DELIVERED complete their sale immediately
      // (stock deduction + finance + serial lifecycle).
      if (row.status === "DELIVERED") {
        await fulfillElectronicsOrder(row, businessId, branchCode, data.createdByName, data.createdByRole);
        row.fulfilledDate = today;
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── SERIAL: register a unit for serial number tracking ─────────────
    if (entity === "SERIAL") {
      const serialNumber = String(data.serialNumber || "").trim() || `SN-ELC-${stamp}`;
      const dupe = await db
        .select()
        .from(electronicsSerials)
        .where(eq(electronicsSerials.serialNumber, serialNumber));
      if (dupe.length > 0) {
        return NextResponse.json({ success: false, error: `Serial ${serialNumber} is already registered` }, { status: 409 });
      }
      const wMonths = Number(data.warrantyMonths) || 12;
      const saleDate = data.saleDate || null;
      let warrantyEnd = data.warrantyEnd || null;
      if (!warrantyEnd && saleDate) {
        const d = new Date(saleDate);
        d.setMonth(d.getMonth() + wMonths);
        warrantyEnd = d.toISOString().split("T")[0];
      }
      const [row] = await db
        .insert(electronicsSerials)
        .values({
          businessId,
          branchCode,
          serialNumber,
          productName: data.productName || "Electronics Item",
          brand: data.brand || null,
          inventoryId: data.inventoryId ? Number(data.inventoryId) : null,
          status: ["IN_STOCK", "SOLD", "RESERVED", "RETURNED", "UNDER_REPAIR"].includes(data.status) ? data.status : "IN_STOCK",
          customerName: data.customerName || null,
          saleDate,
          warrantyMonths: wMonths,
          warrantyEnd,
          priceGhs: Number(data.priceGhs) || 0,
          createdByName: data.createdByName || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── WARRANTY: log a claim / return / repair; linked serial goes UNDER_REPAIR ──
    if (entity === "WARRANTY") {
      const [row] = await db
        .insert(electronicsWarranties)
        .values({
          businessId,
          branchCode,
          claimNumber: data.claimNumber || `WRT-TEC-${new Date().getFullYear()}-${stamp}`,
          productName: data.productName || "Electronics Item",
          serialNumber: data.serialNumber || null,
          customerName: data.customerName || "Walk-in Customer",
          customerPhone: data.customerPhone || null,
          issueType: ["WARRANTY_CLAIM", "RETURN", "REPAIR"].includes(data.issueType) ? data.issueType : "WARRANTY_CLAIM",
          status: ["OPEN", "IN_PROGRESS", "RESOLVED", "CANCELLED"].includes(data.status) ? data.status : "OPEN",
          description: data.description || null,
          costGhs: Number(data.costGhs) || 0,
          loggedDate: data.loggedDate || today,
          handledByName: data.createdByName || null,
          handledByRole: data.createdByRole || null,
        })
        .returning();
      // If the claim references a tracked serial, mark the unit accordingly
      if (data.serialNumber && ["OPEN", "IN_PROGRESS"].includes(row.status)) {
        await db
          .update(electronicsSerials)
          .set({ status: row.issueType === "RETURN" ? "RETURNED" : "UNDER_REPAIR" })
          .where(eq(electronicsSerials.serialNumber, data.serialNumber));
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── PURCHASE: supplier purchase; RECEIVED stock flows into Inventory + Finance ──
    if (entity === "PURCHASE") {
      const qty = Math.max(1, Number(data.quantity) || 1);
      const cost = Number(data.unitCostGhs) || 0;
      const status = ["ORDERED", "RECEIVED", "CANCELLED"].includes(data.status) ? data.status : "ORDERED";
      const [row] = await db
        .insert(electronicsPurchases)
        .values({
          businessId,
          branchCode,
          purchaseNumber: data.purchaseNumber || `PO-TEC-${new Date().getFullYear()}-${stamp}`,
          supplierName: data.supplierName || "Supplier",
          itemName: data.itemName || "Electronics Item",
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
        // Stock-in: match an inventory item by explicit id, then by name prefix; create if absent
        const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
        let target = data.inventoryId
          ? inv.find((i: any) => i.id === Number(data.inventoryId))
          : undefined;
        if (!target) {
          const key = String(data.itemName || "").toUpperCase().slice(0, 12);
          target = inv.find((i: any) => i.name?.toUpperCase().includes(key) || key.includes(String(i.name || "").toUpperCase().slice(0, 12)));
        }
        if (target) {
          const newQty = (target.quantity || 0) + qty;
          await db
            .update(inventoryItems)
            .set({
              quantity: newQty,
              costPriceGhs: cost || target.costPriceGhs,
              status: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= target.minStockThreshold ? "LOW_STOCK" : "IN_STOCK",
            })
            .where(eq(inventoryItems.id, target.id));
        } else {
          const taken = new Set((await db.select({ sku: inventoryItems.sku }).from(inventoryItems)).map((r: any) => r.sku));
          let sku = `TEC-${String(data.itemName || "ITEM").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18)}`;
          let n = 2;
          while (taken.has(sku)) sku = `${sku.slice(0, 20)}-${n++}`;
          await db.insert(inventoryItems).values({
            name: data.itemName,
            sku,
            businessId,
            category: "Electronics & Solar",
            quantity: qty,
            unit: "Units",
            costPriceGhs: cost,
            sellingPriceGhs: Number(data.sellingPriceGhs) || Math.round(cost * 1.3 * 100) / 100,
            minStockThreshold: 5,
            status: "IN_STOCK",
          });
        }

        // Optionally book the purchase as an expense in the shared Finance ledger
        if (data.recordExpense !== false) {
          const now = new Date();
          await db.insert(transactions).values({
            businessId,
            branchCode,
            branchName: biz?.name || null,
            transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`,
            type: "EXPENSE",
            category: "Stock Purchase (Electronics)",
            amountGhs: qty * cost,
            paymentMethod: data.paymentMethod || "BANK_TRANSFER",
            description: `Purchase ${row.purchaseNumber} — ${qty} x ${data.itemName} from ${data.supplierName}`,
            date: data.receivedDate || today,
            recordedBy: data.createdByName || "Electronics Shop User",
            recordedByRole: data.createdByRole || null,
            recordedByUserId: data.createdByUserId ? Number(data.createdByUserId) : null,
            status: "COMPLETED",
          });
        }
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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

    // ── ORDER status progression ────────────────────────────────────────
    if (entity === "ORDER") {
      const [before] = await db
        .select()
        .from(electronicsOrders)
        .where(eq(electronicsOrders.id, Number(id)));
      const [row] = await db
        .update(electronicsOrders)
        .set({
          status: data?.status || undefined,
          notes: data?.notes !== undefined ? data.notes : undefined,
        })
        .where(eq(electronicsOrders.id, Number(id)))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });
      // Completing the delivery converts the order into a sale exactly once:
      // stock is deducted, finance records the revenue, serials become SOLD.
      if (row.status === "DELIVERED" && before?.status !== "DELIVERED" && !row.fulfilledDate) {
        await fulfillElectronicsOrder(row, row.businessId, row.branchCode, data?.actorName || row.createdByName, data?.actorRole || row.createdByRole);
        row.fulfilledDate = today;
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── WARRANTY claim lifecycle; resolving restores the linked serial ──
    if (entity === "WARRANTY") {
      const [existing] = await db
        .select()
        .from(electronicsWarranties)
        .where(eq(electronicsWarranties.id, Number(id)));
      if (!existing) {
        return NextResponse.json({ success: false, error: "Claim not found" }, { status: 404 });
      }
      const newStatus = data?.status || existing.status;
      const [row] = await db
        .update(electronicsWarranties)
        .set({
          status: newStatus,
          description: data?.description !== undefined ? data.description : existing.description,
          costGhs: data?.costGhs !== undefined ? Number(data.costGhs) : existing.costGhs,
          resolvedDate: ["RESOLVED", "CANCELLED"].includes(newStatus) ? today : existing.resolvedDate,
        })
        .where(eq(electronicsWarranties.id, Number(id)))
        .returning();
      if (["RESOLVED", "CANCELLED"].includes(newStatus) && existing.serialNumber) {
        await db
          .update(electronicsSerials)
          .set({ status: existing.issueType === "RETURN" ? "RETURNED" : existing.status === "OPEN" || existing.status === "IN_PROGRESS" ? "SOLD" : "IN_STOCK" })
          .where(eq(electronicsSerials.serialNumber, existing.serialNumber));
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── SERIAL status update ────────────────────────────────────────────
    if (entity === "SERIAL") {
      const [row] = await db
        .update(electronicsSerials)
        .set({
          status: data?.status || undefined,
          customerName: data?.customerName !== undefined ? data.customerName : undefined,
          saleDate: data?.saleDate !== undefined ? data.saleDate : undefined,
        })
        .where(eq(electronicsSerials.id, Number(id)))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Serial not found" }, { status: 404 });
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
