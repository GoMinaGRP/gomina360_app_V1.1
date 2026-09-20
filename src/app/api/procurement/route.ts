import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { auditTrail, customerTrackings, goodsReceipts, inventoryItems, supplierOrders, suppliers } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { accessibleBusinessIds, canAccessBusiness, filterByAccess, getSessionInfo } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import {
  SUPPLIER_ORDER_NEXT,
  SupplierOrderStatus,
  notifyPreorderMilestone,
  postGoodsReceipt,
  propagatePoStage,
  uniquePurchaseNumber,
} from "@/lib/preorder";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";

/** GET: procurement register — scoped supplier orders + receipts. */
export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    const me = session.user;
    const url = new URL(request.url);
    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;
    const statusFilter = (url.searchParams.get("status") || "").trim().toUpperCase();

    const allowed = await accessibleBusinessIds(me);
    // Suppliers for the Raise-PO dropdown — org-scoped like everything else.
    const myOrgIds: number[] = Array.isArray(me.organizationIds) ? me.organizationIds.map(Number) : [];
    let supplierRows = await db.select().from(suppliers);
    if (!me.isSuperAdmin) supplierRows = supplierRows.filter((sp) => myOrgIds.includes(Number(sp.ownerId ?? -1)));
    const suppliersOut = supplierRows.map((sp) => ({
      id: sp.id, name: sp.name, category: sp.category,
      contactPhone: sp.phone, contactPerson: sp.contactPerson, paymentTerms: sp.paymentTerms,
    }));
    let rows = filterByAccess(await db.select().from(supplierOrders), allowed);
    if (bizFilter) rows = rows.filter((r) => Number(r.businessId) === bizFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    rows.sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

    // Linked customer trackings + receipts for the detail drawer.
    const poIds = rows.map((r: any) => r.id);
    const receipts = poIds.length ? await db.select().from(goodsReceipts).where(inArray(goodsReceipts.supplierOrderId, poIds)) : [];
    const byPo = new Map<number, any[]>();
    for (const rc of receipts) {
      const list = byPo.get(rc.supplierOrderId) || [];
      list.push(rc);
      byPo.set(rc.supplierOrderId, list);
    }

    return NextResponse.json({
      success: true,
      orders: rows.map((r: any) => ({
        ...r,
        receipts: byPo.get(r.id) || [],
        canAdvance: (SUPPLIER_ORDER_NEXT[r.status as SupplierOrderStatus] || []),
      })),
      suppliers: suppliersOut,
      meta: { scope: allowed === null ? "ALL" : allowed },
    });
  } catch (error: any) {
    console.error("GET /api/procurement error:", error);
    return apiError(error);
  }
}

/** POST actions:
 *  RAISE { businessId, supplierName?, supplierId?, items[], expectedAt, shippingMethodKey, notes }
 *  ADVANCE { id, status, note? }       — walk RAISED→SENT→SHIPPED→IN_TRANSIT→ARRIVED
 *  RECEIVE { id, items?, notes }       — post goods receipt (stock gate)
 *  CANCEL { id, note? }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    const me = session.user;
    const body = await request.json();
    const action = String(body.action || "").toUpperCase();

    if (action === "RAISE") {
      const businessId = Number(body.businessId);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) return NextResponse.json({ success: false, error: "You cannot raise purchases for this unit." }, { status: 403 });
      const ownerOrg = await ownerOrgOfBusiness(businessId);

      const trackingBags: any[] = [];
      // Tolerate both UIs: Procurement panel posts `lines` (quantity),
      // lower-overhead callers post `items` (qty). Normalize here.
      const rows: any[] = (Array.isArray(body.items) ? body.items : Array.isArray(body.lines) ? body.lines : []).map((li: any) => ({
        ...li,
        inventoryId: li.inventoryId,
        qty: li.qty ?? li.quantity,
        unitCostGhs: li.unitCostGhs ?? li.unitCost ?? 0,
        description: li.description ?? li.productName,
      }));
      if (Array.isArray(body.trackingIds)) {
        for (const t of body.trackingIds) trackingBags.push(t);
      }
      if (!rows.length) return NextResponse.json({ success: false, error: "Add at least one line item." }, { status: 400 });
      const items: any[] = [];
      let total = 0;
      const trackingIds = new Set<number>();
      for (const li of rows.slice(0, 80)) {
        const qty = Number(li.qty) || 0;
        const cost = Math.max(0, Number(li.unitCostGhs) || 0);
        const invId = Number(li.inventoryId || 0);
        if (!(qty > 0) || !invId) return NextResponse.json({ success: false, error: "Every line needs an inventory item and a positive quantity." }, { status: 400 });
        const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, invId));
        if (!inv || Number(inv.businessId) !== businessId) {
          return NextResponse.json({ success: false, error: "Purchase lines must target this unit's stock catalogue." }, { status: 400 });
        }
        if (li.trackingId != null) {
          const tid = Number(li.trackingId);
          if (Number.isFinite(tid) && tid > 0) trackingIds.add(tid);
        }
        items.push({ inventoryId: inv.id, description: String(li.description || inv.name), qty: Math.round(qty * 100) / 100, unitCostGhs: cost, trackingId: li.trackingId ?? null });
        total += qty * cost;
      }
      for (const t of trackingBags) {
        const tid = Number(t);
        if (Number.isFinite(tid) && tid > 0) trackingIds.add(tid);
      }
      // Validate every linked preorder belongs to this unit.
      if (trackingIds.size) {
        const links = await db.select().from(customerTrackings).where(inArray(customerTrackings.id, [...trackingIds]));
        if (links.some((t) => Number(t.businessId) !== businessId)) {
          return NextResponse.json({ success: false, error: "Linked customer orders must belong to this unit." }, { status: 400 });
        }
      }

      let supplierId = body.supplierId != null ? Number(body.supplierId) : null;
      let supplierName = String(body.supplierName || "").trim().slice(0, 120);
      if (supplierId != null) {
        const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId));
        if (!sup || Number(sup.ownerId || ownerOrg) !== Number(ownerOrg)) supplierId = null;
        else supplierName = supplierName || sup.name;
      }
      if (!supplierName && supplierId != null) {
        return NextResponse.json({ success: false, error: "That supplier does not belong to your organization." }, { status: 400 });
      }
      supplierName = supplierName || "Ad-hoc supplier";

      const pnum = await uniquePurchaseNumber();
      const expectedAt = String(body.expectedAt || "").slice(0, 10) || null;
      const methodKey = String(body.shippingMethodKey || "").trim().toUpperCase().slice(0, 20) || null;
      const [po] = await db
        .insert(supplierOrders)
        .values({
          purchaseNumber: pnum,
          ownerId: ownerOrg ?? 1,
          businessId,
          branchCode: body.branchCode || null,
          supplierId,
          supplierName,
          shippingMethodKey: methodKey,
          trackingLineIds: [...trackingIds],
          status: "RAISED",
          expectedAt,
          currency: "GHS",
          items,
          totalGhs: Math.round(total * 100) / 100,
          statusHistory: [{ status: "RAISED", at: new Date().toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: body.note || null }],
          notes: String(body.notes || "").trim().slice(0, 400) || null,
          createdByUserId: me.id ?? null,
          createdByName: me.name || "Staff",
          createdByRole: me.role || "WORKER",
        })
        .returning();

      // Move linked preorders RECEIVED → CONFIRMED → PROCUREMENT if staff chose
      // “raise immediately” (the PO is the demand commitment the customer waits on).
      const poStage = "PROCUREMENT";
      if (trackingIds.size) {
        const links = await db.select().from(customerTrackings).where(inArray(customerTrackings.id, [...trackingIds]));
        const now = new Date();
        for (const row of links) {
          if (row.orderKind === "STOCK") continue;
          if (!["RECEIVED", "CONFIRMED"].includes(row.status)) continue;
          const history = [...(Array.isArray(row.statusHistory) ? (row.statusHistory as any[]) : [])];
          history.push({
            status: poStage,
            at: now.toISOString(),
            by: me.name || "Staff",
            byRole: me.role || "WORKER",
            note: `Supplier order ${pnum} raised with ${supplierName}.`,
          });
          await db
            .update(customerTrackings)
            .set({ status: poStage, supplierOrderId: po.id, statusHistory: history, updatedAt: now })
            .where(eq(customerTrackings.id, row.id));
        }
      }

      await auditLog(me, "CREATE", "RECORD", `Supplier order ${pnum}`, "SUPPLIER_ORDER", po.id, businessId, null, `Raised ${items.length} line(s) totalling GH₵ ${total.toFixed(2)} with ${supplierName}`, ownerOrg);
      return NextResponse.json({ success: true, order: po });
    }

    if (action === "ADVANCE") {
      const id = Number(body.id);
      const target = String(body.status || "").toUpperCase();
      const [po] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id));
      if (!po) return NextResponse.json({ success: false, error: "Supplier order not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(po.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      const next = SUPPLIER_ORDER_NEXT[po.status as SupplierOrderStatus] || [];
      if (!next.includes(target as SupplierOrderStatus)) {
        return NextResponse.json({ success: false, error: `Cannot go ${po.status} → ${target}. Next: ${next.join(" · ") || "—"}.` }, { status: 400 });
      }
      const now = new Date();
      const history = [...(Array.isArray(po.statusHistory) ? (po.statusHistory as any[]) : [])];
      history.push({ status: target, at: now.toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: body.note || null });
      const [row] = await db
        .update(supplierOrders)
        .set({ status: target, statusHistory: history, updatedAt: now })
        .where(eq(supplierOrders.id, id))
        .returning();
      const ownerOrg = Number(po.ownerId);
      await propagatePoStage({ po: { ...po }, status: target, staff: me });

      // Notify customers track-side only when a visible milestone advances their order.
      if (["SHIPPED", "IN_TRANSIT", "ARRIVED"].includes(target)) {
        const links = Array.isArray(po.trackingLineIds) ? po.trackingLineIds : [];
        for (const tid of links) {
          const [trow] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, Number(tid)));
          if (trow) {
            await notifyPreorderMilestone({
              businessId: trow.businessId,
              code: trow.trackingCode,
              milestone: (SUPPLIER_ORDER_NEXT as any)[target] ? target : target,
              detail: `Your pre-order goods are ${target === "SHIPPED" ? "shipped by the supplier" : target}.`,
            });
          }
        }
      }
      await auditLog(me, "UPDATE", "RECORD", `Supplier order ${po.purchaseNumber}`, "SUPPLIER_ORDER", id, Number(po.businessId), null, `${po.status} → ${target}`, ownerOrg);
      return NextResponse.json({ success: true, order: row });
    }

    if (action === "RECEIVE") {
      const id = Number(body.id);
      const [po] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id));
      if (!po) return NextResponse.json({ success: false, error: "Supplier order not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(po.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      const result = await postGoodsReceipt({ po, items: body.items, staff: me, notes: body.notes });
      if (result.problems.length) {
        return NextResponse.json({ success: false, error: result.problems.join(" "), problems: result.problems }, { status: 409 });
      }
      const now = new Date();
      const history = [...(Array.isArray(po.statusHistory) ? (po.statusHistory as any[]) : [])];
      history.push({ status: "RECEIVED", at: now.toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: `Goods receipt ${result.receiptId} posted.` });
      const [updated] = await db
        .update(supplierOrders)
        .set({ status: "RECEIVED", expenseBooked: true, statusHistory: history, updatedAt: now })
        .where(eq(supplierOrders.id, id))
        .returning();
      await propagatePoStage({ po: { ...po }, status: "RECEIVED", staff: me });
      await auditLog(
        me,
        "UPDATE",
        "RECORD",
        `Goods receipt ${result.receiptId}`,
        "GOODS_RECEIPT",
        result.receiptRecordId,
        Number(po.businessId),
        null,
        `Received ${(Array.isArray(updated.items) ? updated.items.length : 0) || 0} line(s) from ${po.supplierName} — stock posted to inventory`,
        Number(po.ownerId),
      );
      return NextResponse.json({ success: true, order: updated, receiptNumber: result.receiptId });
    }

    if (action === "CANCEL") {
      const id = Number(body.id);
      const [po] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id));
      if (!po) return NextResponse.json({ success: false, error: "Supplier order not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(po.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (po.status === "RECEIVED") return NextResponse.json({ success: false, error: "Received orders cannot be cancelled — write off stock instead." }, { status: 409 });
      const now = new Date();
      const history = [...(Array.isArray(po.statusHistory) ? (po.statusHistory as any[]) : [])];
      history.push({ status: "CANCELLED", at: now.toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: body.note || null });
      const [upd] = await db
        .update(supplierOrders)
        .set({ status: "CANCELLED", statusHistory: history, updatedAt: now })
        .where(eq(supplierOrders.id, id))
        .returning();
      return NextResponse.json({ success: true, order: upd });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/procurement error:", error);
    return apiError(error);
  }
}
