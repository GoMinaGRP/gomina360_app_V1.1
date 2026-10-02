import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  businesses,
  customerTrackings,
  inventoryItems,
  inventoryVariants,
  salesDocuments,
  transactions,
} from "@/db/schema";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ttlInvalidate } from "@/lib/ttlCache";
import { postOrGateExpenseTransaction } from "@/lib/expensePosting";
import { lowStockItemsForBusiness } from "@/lib/lowStock";
import { canDeleteInventory, canManageBusinessUnit } from "@/lib/recordPermissions";
import {
  adjustVariantStock,
  deactivateVariant,
  listVariantsByItem,
  lowStockVariantsForBusiness,
  setVariantsForItem,
  variantsForItem,
} from "@/lib/boutique";
import { MAX_VARIANTS_PER_ITEM } from "@/lib/boutiqueSizes";

/**
 * Boutique module API — SIZE / COLOUR variant stock + the unit's dashboard.
 *
 * The Boutique business type REUSES the existing GoMina backbones — Inventory,
 * Sales, Expenses, Finance, Customers, Suppliers, Reports, Audit and the
 * Customer Order system. Nothing here duplicates them:
 *   • inventory_items stays the ONE stock register (its `quantity` is the live
 *     aggregate of the variant rows, kept in sync by lib/boutique.ts);
 *   • inventory_variants only answers "which SIZE/COLOUR moved" and is what
 *     this route reads/writes;
 *   • money always flows through the shared transactions / sales_documents
 *     pipelines (expense booking delegates to postOrGateExpenseTransaction).
 *
 * GET  /api/boutique?businessId=N            → dashboard + variant matrix
 * GET  /api/boutique?businessId=N&variantsOnly=1 → lightweight matrix (staff POS)
 * POST /api/boutique { action: SET_VARIANTS | ADJUST_STOCK | DELETE_VARIANT }
 *
 * Access: every read/write is canAccessBusiness-scoped (tenant isolation) and
 * writes are permission-gated exactly like the shared modules:
 *   • SET_VARIANTS / DELETE_VARIANT → inventory-edit gate
 *     (canDeleteInventory || owner-delegated unit manager)
 *   • ADJUST_STOCK → any business member, but booking the landed cost as an
 *     expense additionally requires canRecordExpenses for WORKERs (same rule
 *     as the Hardware GRN and feed-mill intake).
 */

const OPEN_STATUSES = ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED"];
const DONE_STATUSES = ["DELIVERED", "COMPLETED"];

const r2 = (n: number) => Math.round(n * 100) / 100;

type Bucket = { key: string; label: string; qty: number; revenue: number };
function bump(map: Map<string, Bucket>, key: string, label: string, qty: number, revenue: number) {
  const hit = map.get(key) || { key, label, qty: 0, revenue: 0 };
  hit.qty += qty;
  hit.revenue += revenue;
  map.set(key, hit);
}
function top(map: Map<string, Bucket>, limit = 8): Bucket[] {
  return [...map.values()]
    .map((b) => ({ ...b, revenue: r2(b.revenue) }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, limit);
}

function lineOfType(value: unknown): string {
  const t = String(value || "");
  return t === "INVOICE" || t === "RECEIPT" ? t : "";
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const url = new URL(request.url);
    const businessId = Number(url.searchParams.get("businessId") || 0);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that business.");

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });

    // Lightweight projection for the staff POS / inventory screens that only
    // need the variant matrix (skips the dashboard aggregate queries).
    if (url.searchParams.get("variantsOnly") === "1") {
      const variants = await listVariantsByItem(businessId);
      return NextResponse.json({
        success: true,
        business: { id: biz.id, name: biz.name, code: biz.code, category: biz.category },
        variants: Object.fromEntries([...variants.entries()].map(([k, v]) => [String(k), v])),
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const monthPrefix = today.slice(0, 7);

    // ── Existing registers, business-scoped (bounded reads) ──────────────
    const [items, txRows, orderRows, docRows, variantsByItem, lowItems, lowVariants] = await Promise.all([
      db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId)),
      db
        .select({
          type: transactions.type,
          amountGhs: transactions.amountGhs,
          date: transactions.date,
          category: transactions.category,
        })
        .from(transactions)
        .where(eq(transactions.businessId, businessId))
        .orderBy(desc(transactions.id))
        .limit(3000),
      db
        .select({
          id: customerTrackings.id,
          trackingCode: customerTrackings.trackingCode,
          customerName: customerTrackings.customerName,
          customerPhone: customerTrackings.customerPhone,
          items: customerTrackings.items,
          totalGhs: customerTrackings.totalGhs,
          status: customerTrackings.status,
          orderKind: customerTrackings.orderKind,
          fulfillmentType: customerTrackings.fulfillmentType,
          createdAt: customerTrackings.createdAt,
          updatedAt: customerTrackings.updatedAt,
        })
        .from(customerTrackings)
        .where(eq(customerTrackings.businessId, businessId))
        .orderBy(desc(customerTrackings.id))
        .limit(400),
      db
        .select({ lineItems: salesDocuments.lineItems })
        .from(salesDocuments)
        .where(
          and(
            eq(salesDocuments.businessId, businessId),
            inArray(salesDocuments.documentType, ["RECEIPT", "INVOICE"]),
          ),
        )
        .orderBy(desc(salesDocuments.id))
        .limit(500),
      listVariantsByItem(businessId),
      lowStockItemsForBusiness(businessId),
      lowStockVariantsForBusiness(businessId),
    ]);

    // ── Sales / expenses / profit from the shared ledger ─────────────────
    const incomeToday = txRows.filter((t) => t.type === "INCOME" && (t.date || "").slice(0, 10) === today);
    const incomeMonth = txRows.filter((t) => t.type === "INCOME" && (t.date || "").slice(0, 7) === monthPrefix);
    const expenseMonth = txRows.filter((t) => t.type === "EXPENSE" && (t.date || "").slice(0, 7) === monthPrefix);
    const salesToday = r2(incomeToday.reduce((s, t) => s + (Number(t.amountGhs) || 0), 0));
    const salesMonth = r2(incomeMonth.reduce((s, t) => s + (Number(t.amountGhs) || 0), 0));
    const expensesMonth = r2(expenseMonth.reduce((s, t) => s + (Number(t.amountGhs) || 0), 0));
    const salesTotal = r2(txRows.filter((t) => t.type === "INCOME").reduce((s, t) => s + (Number(t.amountGhs) || 0), 0));

    // ── Inventory picture (aggregate register + variant layer) ───────────
    const costValue = r2(items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.costPriceGhs) || 0), 0));
    const retailValue = r2(items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.sellingPriceGhs) || 0), 0));
    const variantRows = [...variantsByItem.values()].flat();
    const unitsOnHand = r2(items.reduce((s, i) => s + (Number(i.quantity) || 0), 0));

    // ── Orders (existing Customer Order system) ─────────────────────────
    const openOrders = orderRows.filter((o) => OPEN_STATUSES.includes((o.status || "").toUpperCase()));
    const doneOrders = orderRows.filter((o) => DONE_STATUSES.includes((o.status || "").toUpperCase()));
    const ordersSummary = {
      total: orderRows.length,
      open: openOrders.length,
      done: doneOrders.length,
      cancelled: orderRows.filter((o) => (o.status || "").toUpperCase() === "CANCELLED").length,
      pipelineValue: r2(openOrders.reduce((s, o) => s + (Number(o.totalGhs) || 0), 0)),
      recent: orderRows.slice(0, 25),
    };

    // ── Best sellers: products, sizes, colours (sales documents only) ────
    const productAgg = new Map<string, Bucket>();
    const sizeAgg = new Map<string, Bucket>();
    const colorAgg = new Map<string, Bucket>();
    for (const doc of docRows) {
      const lineItems = Array.isArray(doc.lineItems) ? (doc.lineItems as any[]) : [];
      for (const li of lineItems) {
        const qty = Number(li?.quantity) || 0;
        const revenue = Number(li?.total) || 0;
        const base = String(li?.description || "Product")
          .replace(/\s*\[\s*(?:Size|Colour|Color)\s*:[^\]]*\]\s*$/i, "")
          .trim();
        bump(productAgg, `${li?.sku || base.toLowerCase()}`, base, qty, revenue);
        const size = String(li?.size || "").trim();
        const color = String(li?.color || "").trim();
        if (size) bump(sizeAgg, size.toUpperCase(), size, qty, revenue);
        if (color) bump(colorAgg, color.toLowerCase(), color, qty, revenue);
      }
    }

    const lowVariantIds = new Set((lowVariants || []).map((v: any) => Number(v.id)));
    const lowVariantByInventory = new Map<number, number>();
    for (const v of lowVariants || []) {
      lowVariantByInventory.set(Number((v as any).inventoryId), (lowVariantByInventory.get(Number((v as any).inventoryId)) || 0) + 1);
    }

    return NextResponse.json({
      success: true,
      business: { id: biz.id, name: biz.name, code: biz.code, category: biz.category, currency: "GHS" },
      generatedAt: new Date().toISOString(),
      variants: Object.fromEntries([...variantsByItem.entries()].map(([k, v]) => [String(k), v])),
      inventory: {
        itemCount: items.length,
        variantItemCount: variantsByItem.size,
        unitsOnHand,
        costValue,
        retailValue,
        lowStockItems: lowItems,
        lowStockVariants: lowVariants,
      },
      variantSummary: {
        total: variantRows.length,
        out: variantRows.filter((v) => (Number(v.quantity) || 0) <= 0).length,
        low: variantRows.filter(
          (v) => (Number(v.quantity) || 0) > 0 && (Number(v.quantity) || 0) <= (Number(v.minStockThreshold) || 0),
        ).length,
        itemsWithLowVariants: lowVariantIds.size > 0 ? lowVariantByInventory.size : 0,
      },
      sales: { today: salesToday, month: salesMonth, total: salesTotal, transactions: incomeMonth.length },
      expenses: { month: expensesMonth, transactions: expenseMonth.length },
      profit: { month: r2(salesMonth - expensesMonth) },
      orders: ordersSummary,
      bestSellers: {
        products: top(productAgg),
        sizes: top(sizeAgg),
        colors: top(colorAgg),
      },
    });
  } catch (error: any) {
    console.error("GET /api/boutique error:", error);
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const action = String(body.action || "").toUpperCase();
    const businessId = Number(body.businessId);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that business.");

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });

    /** Inventory-structure gate — same rule as editing an inventory entry. */
    const canConfigure = canDeleteInventory(me) || canManageBusinessUnit(me, businessId) || me.isSuperAdmin === true;
    const requireConfigure = () =>
      NextResponse.json(
        {
          success: false,
          error:
            "Not permitted — only the OWNER (or a manager the OWNER granted inventory management) can change a product's sizes/colours.",
        },
        { status: 403 },
      );

    // ── Set / replace a product's size × colour matrix ───────────────────
    if (action === "SET_VARIANTS") {
      if (!canConfigure) return requireConfigure();
      const inventoryId = Number(body.inventoryId);
      const [item] = await db
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, inventoryId), eq(inventoryItems.businessId, businessId)));
      if (!item) return NextResponse.json({ success: false, error: "Product not found in this business." }, { status: 404 });
      const matrix = Array.isArray(body.variants) ? body.variants : [];
      if (matrix.length > MAX_VARIANTS_PER_ITEM) {
        return NextResponse.json(
          { success: false, error: `A product can have at most ${MAX_VARIANTS_PER_ITEM} size/colour variants.` },
          { status: 400 },
        );
      }
      try {
        const saved = await setVariantsForItem({
          businessId,
          inventoryId,
          variants: matrix,
          replace: body.replace !== false,
          actorName: me.name || null,
        });
        ttlInvalidate("init");
        ttlInvalidate("menu");
        await auditLog(
          me,
          "BOUTIQUE_SET_VARIANTS",
          "INVENTORY_ITEM",
          `${item.name} (${item.sku})`,
          "INVENTORY_ITEM",
          item.id,
          businessId,
          biz.code,
          `Size/colour matrix saved: ${saved.length} variant row(s)${body.replace === false ? " (merged)" : " (replaced)"}.`,
          biz.ownerId ?? null,
        );
        return NextResponse.json({ success: true, inventoryId, variants: saved });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message || "Could not save variants." }, { status: 400 });
      }
    }

    // ── Adjust one variant's stock (restock / stock-take / damage) ───────
    if (action === "ADJUST_STOCK") {
      const variantId = Number(body.variantId);
      const hasDelta = body.delta != null;
      const hasQuantity = body.quantity != null;
      if (!variantId || (!hasDelta && !hasQuantity)) {
        return NextResponse.json({ success: false, error: "variantId and delta or quantity are required." }, { status: 400 });
      }
      // A WORKER may receive stock (like the Hardware GRN), but booking the
      // landed cost writes an EXPENSE — that needs expense permission.
      if (body.recordExpense === true && me.role === "WORKER" && !me.canRecordExpenses) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Booking the restock cost needs expense permission. Untick 'Book the landed cost' or ask a manager to record it.",
          },
          { status: 403 },
        );
      }
      const result = await adjustVariantStock({
        businessId,
        variantId,
        delta: hasDelta ? Number(body.delta) : null,
        quantity: hasQuantity ? Number(body.quantity) : null,
        minStockThreshold: body.minStockThreshold != null ? Number(body.minStockThreshold) : null,
      });
      if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });

      // Optional ledger-backed restock: a positive adjustment with a unit cost
      // books the landed cost through the shared expense pipeline (same
      // exactly-once discipline as the Hardware GRN and feed-mill intake).
      let expensePosted: any = null;
      const deltaUp = hasDelta ? Number(body.delta) : 0;
      const unitCost = Number(body.unitCostGhs) || 0;
      if (deltaUp > 0 && unitCost > 0 && body.recordExpense === true) {
        const variant = result.variant!;
        const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, variant.inventoryId));
        const expense = await postOrGateExpenseTransaction({
          businessId,
          branchCode: biz.code,
          branchName: biz.name,
          category: "BOUTIQUE_STOCK_RESTOCK",
          amountGhs: r2(deltaUp * unitCost),
          paymentMethod: body.paymentMethod || "CASH",
          description: `Boutique restock — ${item?.name || "product"} · ${variant?.size || ""}${variant?.size && variant?.color ? "/" : ""}${variant?.color || ""} × ${deltaUp} @ GH₵${unitCost.toFixed(2)}`,
          date: new Date().toISOString().split("T")[0],
          actor: {
            id: me.id,
            name: me.name || null,
            role: me.role || null,
            isSuperAdmin: !!me.isSuperAdmin,
            organizationIds: (me as any).organizationIds || [],
            canRecordExpenses: !!me.canRecordExpenses,
          },
          targetLabel: `Boutique variant restock (${deltaUp} units)`,
          metadata: { variantId, inventoryId: variant.inventoryId },
        });
        expensePosted = expense.success ? expense.transaction?.id ?? true : expense.error || false;
      }

      ttlInvalidate("init");
      ttlInvalidate("menu");
      const audVariant = result.variant!;
      await auditLog(
        me,
        "BOUTIQUE_ADJUST_VARIANT_STOCK",
        "INVENTORY_VARIANT",
        `Variant #${audVariant.id} · ${audVariant.size || ""}${audVariant.size && audVariant.color ? " / " : ""}${audVariant.color || ""}`.trim(),
        "INVENTORY_VARIANT",
        audVariant.id,
        businessId,
        biz.code,
        `Stock adjusted to ${audVariant.quantity}${expensePosted ? "; restock expense booked" : ""}.`,
        biz.ownerId ?? null,
      );
      return NextResponse.json({ success: true, variant: result.variant, item: result.item, expensePosted });
    }

    // ── Deactivate one variant (soft delete; sales history is kept) ──────
    if (action === "DELETE_VARIANT") {
      if (!canConfigure) return requireConfigure();
      const variantId = Number(body.variantId);
      if (!variantId) return NextResponse.json({ success: false, error: "variantId is required." }, { status: 400 });
      const [target] = await db
        .select()
        .from(inventoryVariants)
        .where(and(eq(inventoryVariants.id, variantId), eq(inventoryVariants.businessId, businessId)));
      if (!target) return NextResponse.json({ success: false, error: "Variant not found in this business." }, { status: 404 });
      const result = await deactivateVariant(businessId, variantId);
      if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      ttlInvalidate("init");
      ttlInvalidate("menu");
      await auditLog(
        me,
        "BOUTIQUE_DELETE_VARIANT",
        "INVENTORY_VARIANT",
        `Variant #${target.id} · ${target.size || ""}${target.size && target.color ? " / " : ""}${target.color || ""}`.trim(),
        "INVENTORY_VARIANT",
        target.id,
        businessId,
        biz.code,
        "Variant deactivated (sales history kept).",
        biz.ownerId ?? null,
      );
      return NextResponse.json({ success: true, item: result.item });
    }

    return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/boutique error:", error);
    return apiError(error);
  }
}
