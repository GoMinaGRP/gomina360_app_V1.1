import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { inventoryItems, transactions, businesses } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * POST /api/branch-unit — operations API for auto-provisioned business units
 * (any business outside the 7 dedicated flagship modules). Mirrors the proven
 * handlers of the flagship modules so every link — Restock → Inventory, Ops
 * activity → Finance feed, Expense → Finance/dashboards — behaves identically.
 *
 * Body: { entity: "RESTOCK" | "EXPENSE" | "OPS_LOG", data: {...} }
 */
export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { entity, data } = body;
    const businessId = Number(data?.businessId);
    if (!entity || !businessId) {
      return NextResponse.json(
        { success: false, error: "entity and businessId required" },
        { status: 400 }
      );
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
    }
    const branchCode = data.branchCode || biz.code;
    const branchName = data.branchName || biz.name;
    const today = new Date().toISOString().split("T")[0];
    const trxNum = () => `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;

    // ── RESTOCK (receive purchased stock) ───────────────────────────
    // Increments the inventory item, refreshes its status + cost price, and —
    // when a cost is provided — books the purchase as an EXPENSE so Finance,
    // the Command Center and reports all update automatically.
    if (entity === "RESTOCK") {
      const inventoryId = Number(data.inventoryId);
      const qty = Number(data.quantity) || 0;
      if (!inventoryId || qty <= 0) {
        return NextResponse.json(
          { success: false, error: "inventoryId and a quantity greater than 0 are required" },
          { status: 400 }
        );
      }
      const [item] = await db
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, inventoryId), eq(inventoryItems.businessId, businessId)));
      if (!item) {
        return NextResponse.json(
          { success: false, error: "Inventory item not found for this business" },
          { status: 404 }
        );
      }
      const unitCost = Number(data.unitCostGhs) || 0;
      const newQty = (item.quantity || 0) + qty;
      const set: any = {
        quantity: newQty,
        status: computeStockStatus(newQty, item.minStockThreshold || 0),
      };
      if (unitCost > 0) set.costPriceGhs = unitCost;
      const [updated] = await db
        .update(inventoryItems)
        .set(set)
        .where(eq(inventoryItems.id, item.id))
        .returning();

      let expenseRow = null;
      const totalCost = Number(data.totalCostGhs) || (unitCost > 0 ? qty * unitCost : 0);
      if (data.recordExpense && totalCost > 0) {
        [expenseRow] = await db
          .insert(transactions)
          .values({
            transactionNumber: trxNum(),
            businessId,
            branchCode,
            branchName,
            type: "EXPENSE",
            category: data.category || "Stock Purchase",
            amountGhs: totalCost,
            paymentMethod: data.paymentMethod || "CASH",
            description: data.description || `Restock: ${qty}× ${item.name} (${item.sku})`,
            date: data.date || today,
            createdAt: new Date(),
            status: "COMPLETED",
            recordedBy: data.recordedBy || "Branch Staff",
            recordedByRole: data.recordedByRole || null,
            recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
          })
          .returning();
      }
      return NextResponse.json({ success: true, item: updated, expense: expenseRow });
    }

    // ── EXPENSE (operating cost straight into Finance) ──────────────
    if (entity === "EXPENSE") {
      const [row] = await db
        .insert(transactions)
        .values({
          transactionNumber: trxNum(),
          businessId,
          branchCode,
          branchName,
          type: "EXPENSE",
          category: data.category || "Operating Expense",
          amountGhs: Number(data.amountGhs) || 0,
          paymentMethod: data.paymentMethod || "CASH",
          description: data.description || "Operating expense",
          date: data.date || today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedBy || "Branch Staff",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    // ── OPS_LOG (daily operational activity, zero-amount feed entry) ─
    // Keeps the dashboard's Activities feed and the shared Transaction module
    // alive for unit types that have no bespoke ops table (yet).
    if (entity === "OPS_LOG") {
      const qty = Number(data.quantity) || 0;
      const [row] = await db
        .insert(transactions)
        .values({
          transactionNumber: trxNum(),
          businessId,
          branchCode,
          branchName,
          type: "OPS_LOG",
          category: data.category || "Operations",
          amountGhs: Number(data.amountGhs) || 0,
          paymentMethod: "NA",
          description:
            data.description ||
            `${data.activityLabel || "Operational activity"}${qty ? ` — ${qty} ${data.unit || "units"}` : ""}`,
          date: data.date || today,
          createdAt: new Date(),
          status: "COMPLETED",
          recordedBy: data.recordedBy || "Branch Staff",
          recordedByRole: data.recordedByRole || null,
          recordedByUserId: data.recordedByUserId ? Number(data.recordedByUserId) : null,
        })
        .returning();
      return NextResponse.json({ success: true, item: row });
    }

    return NextResponse.json({ success: false, error: "Unknown entity" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
