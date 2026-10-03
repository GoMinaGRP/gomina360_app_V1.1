import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  restaurantOrders,
  restaurantMenuItems,
  restaurantWaste,
  restaurantPurchases,
  inventoryItems,
  businesses,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { notifyPurchase, ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";
import { postOrGateExpenseTransaction } from "@/lib/expensePosting";
import { postSale } from "@/lib/salePosting";
import { linkOrCreateCustomer } from "@/lib/customerLink";
import { linkSupplier } from "@/lib/supplierLinks";

// NOTE: the Restaurant menu master list starts EMPTY for every business — no
// sample dishes are auto-seeded (owner directive: new / reset units begin with
// zero sample, test or unrelated data). The demo flagship FOOD-01 receives its
// signature menu from the seed (seed.ts) only.

// Stock-in a received purchase: match inventory by id/name, else create the item.
async function receiveStock(businessId: number, branchCode: string | null, data: any, qty: number, cost: number) {
  const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
  let target = data.inventoryId ? inv.find((i: any) => i.id === Number(data.inventoryId)) : undefined;
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
        expiryDate: data.expiryDate || target.expiryDate || null,
        status: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= target.minStockThreshold ? "LOW_STOCK" : "IN_STOCK",
      })
      .where(eq(inventoryItems.id, target.id));
  } else {
    const taken = new Set((await db.select({ sku: inventoryItems.sku }).from(inventoryItems)).map((r: any) => r.sku));
    let sku = `FOOD-${String(data.itemName || "ITEM").toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 18)}`;
    let n = 2;
    while (taken.has(sku)) sku = `${sku.slice(0, 20)}-${n++}`;
    await db.insert(inventoryItems).values({
      name: data.itemName,
      sku,
      businessId,
      category: "Food & Ingredients",
      quantity: qty,
      unit: data.unit || "Kg",
      costPriceGhs: cost,
      sellingPriceGhs: Number(data.sellingPriceGhs) || 0,
      minStockThreshold: 5,
      status: "IN_STOCK",
      expiryDate: data.expiryDate || null,
    });
  }
}

// Book the purchase expense into the shared Finance ledger.
async function bookExpense(businessId: number, biz: any, branchCode: string | null, data: any, purchaseNumber: string, total: number, date: string, actorObj?: any) {
  const actor = actorObj || {
    id: data.createdByUserId ? Number(data.createdByUserId) : null,
    name: data.createdByName || "Kitchen Staff",
    role: data.createdByRole || null,
  };
  return postOrGateExpenseTransaction({
    businessId,
    branchCode,
    branchName: biz?.name || null,
    category: "Stock Purchase (Kitchen)",
    amountGhs: total,
    paymentMethod: data.paymentMethod || "CASH",
    description: `Purchase ${purchaseNumber} — ${data.quantity} ${data.unit || "Kg"} ${data.itemName} from ${data.supplierName}`,
    date,
    actor,
    targetLabel: `Kitchen Purchase (${data.quantity} ${data.unit || "Kg"} ${data.itemName}) — GH₵ ${Number(total).toFixed(2)}`,
    metadata: { purchaseNumber, supplierName: data.supplierName },
  });
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
    // Scope gate: menu costing, kitchen orders, waste and purchases stay
    // inside the caller's accessible businesses.
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const menu = await db.select().from(restaurantMenuItems).where(eq(restaurantMenuItems.businessId, businessId));
    const [orders, waste, purchases] = await Promise.all([
      db.select().from(restaurantOrders).where(eq(restaurantOrders.businessId, businessId)),
      db.select().from(restaurantWaste).where(eq(restaurantWaste.businessId, businessId)),
      db.select().from(restaurantPurchases).where(eq(restaurantPurchases.businessId, businessId)),
    ]);
    const descId = (a: any, b: any) => (b.id || 0) - (a.id || 0);
    return NextResponse.json({
      success: true,
      menu: menu.slice().sort((a: any, b: any) => (a.id || 0) - (b.id || 0)),
      orders: orders.sort(descId),
      waste: waste.sort(descId),
      purchases: purchases.sort(descId),
    });
  } catch (error: any) {
    return apiError(error);
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
    if (!(await canAccessBusiness(__authSession.user, businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const branchCode = data.branchCode || biz?.code || null;
    const today = new Date().toISOString().split("T")[0];
    const stamp = Date.now().toString().slice(-5);

    // ── ORDER: kitchen ticket ───────────────────────────────────────────
    if (entity === "ORDER") {
      const qty = Math.max(1, Number(data.quantity) || 1);
      const price = Number(data.unitPriceGhs) || 0;
      // Shared CRM: link the guest at ticket time (one record per buyer).
      const buyer = await linkOrCreateCustomer({
        businessId,
        name: data.customerName,
        phone: data.customerPhone,
        amount: 0,
        loyaltyPoints: 0,
        phoneFallback: "—",
      });
      const [row] = await db
        .insert(restaurantOrders)
        .values({
          businessId,
          branchCode,
          orderNumber: data.orderNumber || `ORD-KIT-${new Date().getFullYear()}-${stamp}`,
          customerName: data.customerName || "Walk-in Guest",
          customerPhone: data.customerPhone || null,
          customerId: buyer?.id ?? null,
          itemName: data.itemName || "Menu Item",
          menuItemId: data.menuItemId ? Number(data.menuItemId) : null,
          quantity: qty,
          unitPriceGhs: price,
          totalGhs: qty * price,
          orderType: ["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(data.orderType) ? data.orderType : "DINE_IN",
          status: ["QUEUED", "COOKING", "READY", "SERVED", "CANCELLED"].includes(data.status) ? data.status : "QUEUED",
          orderedDate: data.orderedDate || today,
          notes: data.notes || null,
          createdByName: data.createdByName || null,
          createdByRole: data.createdByRole || null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── MENU_ITEM: extend the menu master ───────────────────────────────
    if (entity === "MENU_ITEM") {
      const name = String(data.name || "").trim();
      if (!name) return NextResponse.json({ success: false, error: "Dish name is required" }, { status: 400 });
      const menu = await db.select().from(restaurantMenuItems).where(eq(restaurantMenuItems.businessId, businessId));
      if (menu.some((m: any) => m.name.toUpperCase() === name.toUpperCase())) {
        return NextResponse.json({ success: false, error: `"${name}" is already on the menu` }, { status: 409 });
      }
      const [row] = await db
        .insert(restaurantMenuItems)
        .values({
          businessId,
          branchCode,
          name,
          category: ["STARTER", "MAIN", "SIDE", "DRINK", "DESSERT"].includes(data.category) ? data.category : "MAIN",
          priceGhs: Number(data.priceGhs) || 0,
          costGhs: Number(data.costGhs) || 0,
          description: data.description || null,
          isActive: true,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── WASTE: food waste log; stock leaves inventory ───────────────────
    if (entity === "WASTE") {
      const qty = Math.max(0.01, Number(data.quantity) || 0);
      const [row] = await db
        .insert(restaurantWaste)
        .values({
          businessId,
          branchCode,
          itemName: data.itemName || "Ingredient",
          inventoryId: data.inventoryId ? Number(data.inventoryId) : null,
          quantity: qty,
          unit: data.unit || "Units",
          reason: ["SPOILAGE", "EXPIRED", "OVERCOOKED", "PREP_LOSS", "CUSTOMER_RETURN"].includes(data.reason) ? data.reason : "SPOILAGE",
          costGhs: Number(data.costGhs) || 0,
          loggedDate: data.loggedDate || today,
          recordedByName: data.createdByName || null,
          recordedByRole: data.createdByRole || null,
          notes: data.notes || null,
        })
        .returning();
      // Decrement matched stock
      const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId));
      let target = data.inventoryId ? inv.find((i: any) => i.id === Number(data.inventoryId)) : undefined;
      if (!target) {
        const key = String(data.itemName || "").toUpperCase().slice(0, 12);
        target = inv.find((i: any) => i.name?.toUpperCase().includes(key));
      }
      if (target) {
        const newQty = Math.max(0, (target.quantity || 0) - qty);
        await db
          .update(inventoryItems)
          .set({ quantity: newQty, status: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= target.minStockThreshold ? "LOW_STOCK" : "IN_STOCK" })
          .where(eq(inventoryItems.id, target.id));
      }
      return NextResponse.json({ success: true, item: row });
    }

    // ── PURCHASE: supplier purchase; RECEIVED → stock-in + expense ──────
    if (entity === "PURCHASE") {
      const qty = Math.max(0.01, Number(data.quantity) || 1);
      const cost = Number(data.unitCostGhs) || 0;
      const status = ["ORDERED", "RECEIVED", "CANCELLED"].includes(data.status) ? data.status : "ORDERED";
      const [row] = await db
        .insert(restaurantPurchases)
        .values({
          businessId,
          branchCode,
          purchaseNumber: data.purchaseNumber || `PO-KIT-${new Date().getFullYear()}-${stamp}`,
          supplierName: data.supplierName || "Market Supplier",
          itemName: data.itemName || "Ingredient",
          quantity: qty,
          unit: data.unit || "Kg",
          unitCostGhs: cost,
          totalGhs: qty * cost,
          status,
          orderDate: data.orderDate || today,
          receivedDate: status === "RECEIVED" ? data.receivedDate || today : null,
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
        unit: row.unit,
        totalGhs: row.totalGhs,
        status: row.status,
        recordId: row.id,
        actorName: data.createdByName || null,
      });

      if (status === "RECEIVED") {
        await receiveStock(businessId, branchCode, data, qty, cost);
        if (data.recordExpense !== false) {
          await bookExpense(businessId, biz, branchCode, { ...data, quantity: qty }, row.purchaseNumber, qty * cost, data.receivedDate || today);
        }
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
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

    if (entity === "ORDER") {
      const [orderBefore] = await db
        .select()
        .from(restaurantOrders)
        .where(eq(restaurantOrders.id, Number(id)));
      if (!orderBefore) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, orderBefore.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(restaurantOrders)
        .set({ status: ["QUEUED", "COOKING", "READY", "SERVED", "CANCELLED"].includes(data?.status) ? data.status : undefined })
        .where(eq(restaurantOrders.id, Number(id)))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });

      // ── Served ticket → the SHARED sale engine, exactly once ──────────
      // Kitchen tickets used to be operational-only: serving a table moved no
      // money, so the ledger (and therefore Finance, Receipts, CRM, Tracking)
      // only ever saw the sales staff remembered to re-key. Now serving posts
      // the ticket through the same engine every other module uses — ledger
      // INCOME + RECEIPT + CRM accrual + tracking code — guarded by
      // `transactionId` so re-serving (or a status ping-pong) never
      // double-counts.
      if (row.status === "SERVED" && !row.transactionId) {
        const qty = Number(row.quantity) || 0;
        const unitPrice = Number(row.unitPriceGhs) || 0;
        const lineTotal = Math.round(qty * unitPrice * 100) / 100;
        const amount = Number(row.totalGhs) || lineTotal;
        // Recipe cost per plate drives real COGS/profit on the receipt.
        const menuRow = row.menuItemId
          ? (await db.select().from(restaurantMenuItems).where(eq(restaurantMenuItems.id, Number(row.menuItemId))))[0]
          : null;
        const posted = await postSale({
          businessId: row.businessId,
          branchCode: row.branchCode,
          lines: [
            {
              description: `${row.itemName} (${row.orderNumber})`,
              quantity: qty,
              unit: "plates",
              category: menuRow?.category || "MENU",
              unitPrice,
              costPrice: Number(menuRow?.costGhs) || 0,
              total: amount,
              originalPrice: unitPrice,
            },
          ],
          customerName: row.customerName,
          customerPhone: row.customerPhone,
          customerId: row.customerId ?? null,
          paymentMethod: data?.paymentMethod || "CASH",
          category: "RESTAURANT_ORDER_SALE",
          description: `Ticket ${row.orderNumber} served: ${qty}× ${row.itemName} — ${row.customerName}`,
          discount: Math.max(0, Math.round((lineTotal - amount) * 100) / 100),
          actor: { name: data?.actorName || row.createdByName, role: data?.actorRole || row.createdByRole, id: data?.actorUserId ?? null },
        });
        if (posted.success) {
          const [saved] = await db
            .update(restaurantOrders)
            .set({
              transactionId: posted.transaction?.id ?? null,
              salesDocumentId: posted.receipt?.id ?? null,
              postedAt: new Date(),
              customerId: posted.customerId ?? row.customerId ?? null,
            })
            .where(eq(restaurantOrders.id, row.id))
            .returning();
          return NextResponse.json({ success: true, item: saved || row, posted: true, transaction: posted.transaction, trackingCode: posted.trackingCode });
        }
      }
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "MENU_ITEM") {
      const [menuBefore] = await db
        .select()
        .from(restaurantMenuItems)
        .where(eq(restaurantMenuItems.id, Number(id)));
      if (!menuBefore) return NextResponse.json({ success: false, error: "Menu item not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, menuBefore.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [row] = await db
        .update(restaurantMenuItems)
        .set({
          name: data?.name || undefined,
          category: data?.category || undefined,
          priceGhs: data?.priceGhs !== undefined ? Number(data.priceGhs) : undefined,
          costGhs: data?.costGhs !== undefined ? Number(data.costGhs) : undefined,
          isActive: data?.isActive !== undefined ? Boolean(data.isActive) : undefined,
        })
        .where(eq(restaurantMenuItems.id, Number(id)))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Menu item not found" }, { status: 404 });
      return NextResponse.json({ success: true, item: row });
    }

    // ORDERED → RECEIVED performs the stock-in + expense booking then
    if (entity === "PURCHASE") {
      const [existing] = await db.select().from(restaurantPurchases).where(eq(restaurantPurchases.id, Number(id)));
      if (!existing) return NextResponse.json({ success: false, error: "Purchase not found" }, { status: 404 });
      if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const newStatus = ["ORDERED", "RECEIVED", "CANCELLED"].includes(data?.status) ? data.status : existing.status;
      const [row] = await db
        .update(restaurantPurchases)
        .set({ status: newStatus, receivedDate: newStatus === "RECEIVED" ? today : existing.receivedDate })
        .where(eq(restaurantPurchases.id, Number(id)))
        .returning();
      if (row.supplierName && Number(row.totalGhs) > 0 && existing.status !== "RECEIVED") {
        const orgId = await ownerOrgOfBusiness(existing.businessId).catch(() => null);
        const [purchaseBiz] = orgId == null
          ? await db.select().from(businesses).where(eq(businesses.id, existing.businessId))
          : [null];
        const linked = await linkSupplier({
          ownerId: orgId ?? (purchaseBiz as any)?.ownerId ?? null,
          name: row.supplierName,
          category: "Food & Ingredients",
          suppliedGhs: Number(row.totalGhs) || 0,
          paymentMethod: data?.paymentMethod,
          logTag: "[restaurant]",
        });
        if (linked?.supplier?.id) {
          await db
            .update(restaurantPurchases)
            .set({ supplierId: linked.supplier.id })
            .where(eq(restaurantPurchases.id, row.id))
            .catch(() => {});
        }
      }

      if (newStatus === "RECEIVED" && existing.status !== "RECEIVED") {
        const [biz] = await db.select().from(businesses).where(eq(businesses.id, existing.businessId));
        await receiveStock(existing.businessId, existing.branchCode, { ...existing, ...data }, existing.quantity, existing.unitCostGhs);
        await notifyPurchase({
          businessId: existing.businessId,
          branchCode: existing.branchCode,
          purchaseNumber: existing.purchaseNumber,
          supplierName: existing.supplierName,
          itemName: existing.itemName,
          quantity: existing.quantity,
          unit: existing.unit,
          totalGhs: existing.totalGhs,
          status: "RECEIVED",
          recordId: existing.id,
          actorName: data?.createdByName || null,
          type: "PURCHASE_RECEIVED",
        });
        if (data?.recordExpense !== false) {
          await bookExpense(existing.businessId, biz, existing.branchCode, { ...existing, createdByName: data?.createdByName, createdByRole: data?.createdByRole, createdByUserId: data?.createdByUserId, paymentMethod: data?.paymentMethod }, existing.purchaseNumber, existing.totalGhs, today);
        }
      }
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: `Unknown entity: ${entity}` }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}
