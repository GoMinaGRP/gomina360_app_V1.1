import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  restaurantOrders,
  restaurantMenuItems,
  restaurantWaste,
  restaurantPurchases,
  inventoryItems,
  transactions,
  businesses,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { notifyPurchase } from "@/lib/notify";

// Menu seeded on first load with the kitchen's known signature dishes so the
// master list matches the operations log's most popular dishes.
const DEFAULT_MENU = [
  { name: "Jollof Rice with Grilled Tilapia & Pepper Sauce", category: "MAIN", priceGhs: 85, costGhs: 38 },
  { name: "Waakye with Fish & Salad", category: "MAIN", priceGhs: 45, costGhs: 19 },
  { name: "Banku with Okro Stew & Goat", category: "MAIN", priceGhs: 60, costGhs: 26 },
  { name: "Fufu with Light Soup & Chicken", category: "MAIN", priceGhs: 70, costGhs: 30 },
  { name: "Grilled Tilapia (Full) with Sides", category: "MAIN", priceGhs: 120, costGhs: 55 },
  { name: "Kelewele with Nuts", category: "STARTER", priceGhs: 20, costGhs: 8 },
  { name: "Palm Wine / Sobolo", category: "DRINK", priceGhs: 15, costGhs: 5 },
  { name: "Fresh Fruit Juice", category: "DRINK", priceGhs: 12, costGhs: 4 },
];

async function ensureMenu(businessId: number, branchCode: string | null) {
  const existing = await db.select().from(restaurantMenuItems).where(eq(restaurantMenuItems.businessId, businessId));
  if (existing.length > 0) return existing;
  const rows = [];
  for (const m of DEFAULT_MENU) {
    const [row] = await db
      .insert(restaurantMenuItems)
      .values({ businessId, branchCode, ...m, isActive: true })
      .returning();
    rows.push(row);
  }
  return rows;
}

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
async function bookExpense(businessId: number, biz: any, branchCode: string | null, data: any, purchaseNumber: string, total: number, date: string) {
  const now = new Date();
  await db.insert(transactions).values({
    businessId,
    branchCode,
    branchName: biz?.name || null,
    transactionNumber: `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`,
    type: "EXPENSE",
    category: "Stock Purchase (Kitchen)",
    amountGhs: total,
    paymentMethod: data.paymentMethod || "CASH",
    description: `Purchase ${purchaseNumber} — ${data.quantity} ${data.unit || "Kg"} ${data.itemName} from ${data.supplierName}`,
    date,
    recordedBy: data.createdByName || "Kitchen Staff",
    recordedByRole: data.createdByRole || null,
    recordedByUserId: data.createdByUserId ? Number(data.createdByUserId) : null,
    status: "COMPLETED",
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
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const menu = await ensureMenu(businessId, biz?.code || null);
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

    // ── ORDER: kitchen ticket ───────────────────────────────────────────
    if (entity === "ORDER") {
      const qty = Math.max(1, Number(data.quantity) || 1);
      const price = Number(data.unitPriceGhs) || 0;
      const [row] = await db
        .insert(restaurantOrders)
        .values({
          businessId,
          branchCode,
          orderNumber: data.orderNumber || `ORD-KIT-${new Date().getFullYear()}-${stamp}`,
          customerName: data.customerName || "Walk-in Guest",
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
      const menu = await ensureMenu(businessId, branchCode);
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

    if (entity === "ORDER") {
      const [row] = await db
        .update(restaurantOrders)
        .set({ status: ["QUEUED", "COOKING", "READY", "SERVED", "CANCELLED"].includes(data?.status) ? data.status : undefined })
        .where(eq(restaurantOrders.id, Number(id)))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });
      return NextResponse.json({ success: true, item: row });
    }

    if (entity === "MENU_ITEM") {
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
      const newStatus = ["ORDERED", "RECEIVED", "CANCELLED"].includes(data?.status) ? data.status : existing.status;
      const [row] = await db
        .update(restaurantPurchases)
        .set({ status: newStatus, receivedDate: newStatus === "RECEIVED" ? today : existing.receivedDate })
        .where(eq(restaurantPurchases.id, Number(id)))
        .returning();
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
