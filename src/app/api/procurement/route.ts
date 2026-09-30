import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import {
  auditTrail,
  customerTrackings,
  goodsReceipts,
  inventoryItems,
  purchaseRequisitions,
  supplierInvoices,
  supplierOrders,
  supplierPayments,
  supplierQuotes,
  suppliers,
  transactions,
} from "@/db/schema";
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
import { approvalGateCheck, createApprovalRequest, cancelApprovalRequest } from "@/lib/approvals";
import {
  nextPaymentNumber,
  nextQuoteNumber,
  nextReqNumber,
  resolveSupplier,
  supplierPerformance,
} from "@/lib/procurement";

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
    if (!me.isSuperAdmin) supplierRows = supplierRows.filter((sp) => myOrgIds.includes(Number(sp.ownerId ?? (myOrgIds.includes(1) ? 1 : -1))));
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

    // R2 chain registers — requisitions, quotes, invoices (+payments) and
    // supplier performance, all scoped to the caller's accessible units.
    let requisitions = await db.select().from(purchaseRequisitions);
    let quotes = await db.select().from(supplierQuotes);
    let invoices = await db.select().from(supplierInvoices);
    let payments = await db.select().from(supplierPayments);
    if (allowed !== null) {
      const scope = new Set((allowed || []).map(Number));
      const inScope = (bizId: any) => scope.has(Number(bizId));
      requisitions = requisitions.filter(inScope);
      quotes = quotes.filter(inScope);
      invoices = invoices.filter(inScope);
      payments = payments.filter(inScope);
    }
    if (bizFilter) {
      requisitions = requisitions.filter((r: any) => Number(r.businessId) === bizFilter);
      quotes = quotes.filter((r: any) => Number(r.businessId) === bizFilter);
      invoices = invoices.filter((r: any) => Number(r.businessId) === bizFilter);
      payments = payments.filter((r: any) => Number(r.businessId) === bizFilter);
    }
    requisitions.sort((a: any, b: any) => b.id - a.id);
    quotes.sort((a: any, b: any) => b.id - a.id);
    invoices.sort((a: any, b: any) => b.id - a.id);
    payments.sort((a: any, b: any) => b.id - a.id);
    // Stock catalogue for the selected unit — powers the requisition/quote
    // line pickers (only inventory-mapped lines can post stock at GRN).
    const inventory = bizFilter
      ? (await db
          .select({ id: inventoryItems.id, name: inventoryItems.name, sku: inventoryItems.sku, unit: inventoryItems.unit, quantity: inventoryItems.quantity, costPriceGhs: inventoryItems.costPriceGhs })
          .from(inventoryItems)
          .where(eq(inventoryItems.businessId, bizFilter)))
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      : [];
    const invoiceIds = invoices.map((i: any) => Number(i.id));
    const invoicePayments = payments.filter((p: any) => invoiceIds.includes(Number(p.invoiceId)));

    return NextResponse.json({
      success: true,
      orders: rows.map((r: any) => ({
        ...r,
        receipts: byPo.get(r.id) || [],
        canAdvance: (SUPPLIER_ORDER_NEXT[r.status as SupplierOrderStatus] || []),
      })),
      suppliers: suppliersOut,
      requisitions,
      quotes,
      invoices: invoices.map((i: any) => ({
        ...i,
        payments: invoicePayments.filter((p: any) => Number(p.invoiceId) === Number(i.id)),
      })),
      payments,
      inventory,
      supplierPerformance: await supplierPerformance(allowed),
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
      // R1 approval gate: gated POs are born PENDING_APPROVAL; approval
      // releases them to RAISED (rejection cancels them). Without a matching
      // policy the PO is born RAISED exactly as before.
      const poGate = await approvalGateCheck({
        user: me,
        action: "PURCHASE_ORDER",
        businessId,
        amountGhs: Math.round(total * 100) / 100,
      });
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
          status: poGate.gated ? "PENDING_APPROVAL" : "RAISED",
          expectedAt,
          currency: "GHS",
          items,
          totalGhs: Math.round(total * 100) / 100,
          statusHistory: [{ status: poGate.gated ? "PENDING_APPROVAL" : "RAISED", at: new Date().toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: poGate.gated ? "Awaiting approval before it can be sent" : body.note || null }],
          notes: String(body.notes || "").trim().slice(0, 400) || null,
          createdByUserId: me.id ?? null,
          createdByName: me.name || "Staff",
          createdByRole: me.role || "WORKER",
        })
        .returning();

      if (poGate.gated) {
        await createApprovalRequest({
          action: "PURCHASE_ORDER",
          businessId,
          branchCode: body.branchCode || null,
          targetType: "SUPPLIER_ORDER",
          targetId: Number(po.id),
          targetLabel: `PO ${pnum} — ${supplierName}`,
          amountGhs: Math.round(total * 100) / 100,
          payloadSnapshot: { purchaseNumber: pnum, supplierName, lineCount: items.length },
          actor: me,
        });
        await auditLog(me, "CREATE", "RECORD", `Supplier order ${pnum} (pending approval)`, "SUPPLIER_ORDER", po.id, businessId, null, `Gated raise of ${items.length} line(s) totalling GH₵ ${total.toFixed(2)} with ${supplierName}`, ownerOrg);
        return NextResponse.json({ success: true, order: po, pendingApproval: true, message: "Purchase order saved as PENDING APPROVAL — the approvers have been notified." });
      }

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

    /* ══════════════════ R2 — PROCUREMENT CHAIN ══════════════════ */

    // ── REQUISITION_CREATE — draft what to buy (lines reference stock items) ──
    if (action === "REQUISITION_CREATE") {
      const businessId = Number(body.businessId);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) return NextResponse.json({ success: false, error: "You cannot raise requisitions for this unit." }, { status: 403 });
      const rawLines = Array.isArray(body.lines) ? body.lines : [];
      if (!rawLines.length) return NextResponse.json({ success: false, error: "Add at least one requisition line." }, { status: 400 });
      const lines: any[] = [];
      for (const li of rawLines.slice(0, 60)) {
        const qty = Number(li.quantity) || 0;
        if (!(qty > 0)) return NextResponse.json({ success: false, error: "Every line needs a positive quantity." }, { status: 400 });
        lines.push({
          inventoryId: Number(li.inventoryId) || null,
          description: String(li.description || li.productName || "Stock item").slice(0, 200),
          quantity: Math.round(qty * 100) / 100,
          unit: li.unit ? String(li.unit).slice(0, 24) : null,
          estUnitCostGhs: li.estUnitCostGhs != null && Number(li.estUnitCostGhs) > 0 ? Number(li.estUnitCostGhs) : null,
        });
      }
      const ownerOrg = await ownerOrgOfBusiness(businessId);
      const reqNumber = await nextReqNumber(Number(ownerOrg) || 1);
      const [row] = await db
        .insert(purchaseRequisitions)
        .values({
          reqNumber,
          ownerId: Number(ownerOrg) || 1,
          businessId,
          branchCode: body.branchCode || null,
          lines,
          needBy: String(body.needBy || "").slice(0, 10) || null,
          source: String(body.source || "MANUAL").toUpperCase() === "LOW_STOCK" ? "LOW_STOCK" : "MANUAL",
          notes: String(body.notes || "").trim().slice(0, 500) || null,
          status: "DRAFT",
          requestedByUserId: me.id ?? null,
          requestedByName: me.name || "Staff",
          requestedByRole: me.role || "WORKER",
        })
        .returning();
      await auditLog(me, "CREATE", "RECORD", `Requisition ${reqNumber}`, "PURCHASE_REQUISITION", row.id, businessId, null, `${lines.length} line(s) drafted`, ownerOrg);
      return NextResponse.json({ success: true, requisition: row });
    }

    // ── REQUISITION_SUBMIT — DRAFT → PENDING_APPROVAL / APPROVED ──
    if (action === "REQUISITION_SUBMIT") {
      const [pr] = await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, Number(body.id)));
      if (!pr) return NextResponse.json({ success: false, error: "Requisition not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(pr.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (String(pr.status) !== "DRAFT") return NextResponse.json({ success: false, error: `Only DRAFT requisitions can be submitted (this one is ${pr.status}).` }, { status: 409 });
      const lines = Array.isArray(pr.lines) ? (pr.lines as any[]) : [];
      const estTotal = lines.reduce((s, li) => s + (Number(li.estUnitCostGhs) || 0) * (Number(li.quantity) || 0), 0);
      const gate = await approvalGateCheck({
        user: me,
        action: "PURCHASE_REQUISITION",
        businessId: Number(pr.businessId),
        amountGhs: Math.round(estTotal * 100) / 100,
      });
      if (gate.gated) {
        const [row] = await db
          .update(purchaseRequisitions)
          .set({ status: "PENDING_APPROVAL", updatedAt: new Date() })
          .where(eq(purchaseRequisitions.id, pr.id))
          .returning();
        const req = await createApprovalRequest({
          action: "PURCHASE_REQUISITION",
          businessId: Number(pr.businessId),
          branchCode: pr.branchCode,
          targetType: "PURCHASE_REQUISITION",
          targetId: Number(pr.id),
          targetLabel: `Requisition ${pr.reqNumber} — ${lines.length} line(s)${estTotal > 0 ? `, ~GH₵ ${estTotal.toFixed(2)}` : ""}`,
          amountGhs: Math.round(estTotal * 100) / 100,
          payloadSnapshot: { reqNumber: pr.reqNumber, lineCount: lines.length },
          actor: me,
        });
        if (req) {
          await db.update(purchaseRequisitions).set({ approvalRequestId: Number(req.id) }).where(eq(purchaseRequisitions.id, pr.id));
        }
        return NextResponse.json({ success: true, requisition: row, pendingApproval: true, message: "Requisition submitted — awaiting approval." });
      }
      const [row] = await db
        .update(purchaseRequisitions)
        .set({ status: "APPROVED", decidedByName: me.name || "Staff", decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(purchaseRequisitions.id, pr.id))
        .returning();
      await auditLog(me, "UPDATE", "RECORD", `Requisition ${pr.reqNumber}`, "PURCHASE_REQUISITION", pr.id, Number(pr.businessId), null, "DRAFT → APPROVED (no policy gate)", Number(pr.ownerId));
      return NextResponse.json({ success: true, requisition: row });
    }

    // ── REQUISITION_CANCEL — withdraw a draft / pending requisition ──
    if (action === "REQUISITION_CANCEL") {
      const [pr] = await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, Number(body.id)));
      if (!pr) return NextResponse.json({ success: false, error: "Requisition not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(pr.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (!["DRAFT", "PENDING_APPROVAL"].includes(String(pr.status))) {
        return NextResponse.json({ success: false, error: `A ${pr.status} requisition cannot be cancelled.` }, { status: 409 });
      }
      if (pr.approvalRequestId) await cancelApprovalRequest(Number(pr.approvalRequestId), { name: me.name, id: me.id, role: me.role });
      const [row] = await db
        .update(purchaseRequisitions)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(purchaseRequisitions.id, pr.id))
        .returning();
      return NextResponse.json({ success: true, requisition: row });
    }

    // ── QUOTE_ADD — register a supplier quotation for a requisition ──
    if (action === "QUOTE_ADD") {
      const businessId = Number(body.businessId);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      const ownerOrg = await ownerOrgOfBusiness(businessId);
      let requisition: any = null;
      if (body.requisitionId != null) {
        [requisition] = await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, Number(body.requisitionId)));
        if (!requisition || Number(requisition.businessId) !== businessId) {
          return NextResponse.json({ success: false, error: "That requisition does not belong to this unit." }, { status: 400 });
        }
      }
      const rawLines = Array.isArray(body.lines) ? body.lines : [];
      if (!rawLines.length) return NextResponse.json({ success: false, error: "Add at least one quoted line." }, { status: 400 });
      // Quote lines may map to the requisition's stock items (for the PO).
      const reqLines: any[] = requisition && Array.isArray(requisition.lines) ? (requisition.lines as any[]) : [];
      const lines: any[] = [];
      let total = 0;
      for (const li of rawLines.slice(0, 60)) {
        const qty = Number(li.quantity) || 0;
        const cost = Math.max(0, Number(li.unitCostGhs) || 0);
        if (!(qty > 0)) return NextResponse.json({ success: false, error: "Every quote line needs a positive quantity." }, { status: 400 });
        const inventoryId = Number(li.inventoryId) || null;
        lines.push({
          inventoryId,
          description: String(li.description || "Quoted item").slice(0, 200),
          quantity: Math.round(qty * 100) / 100,
          unitCostGhs: cost,
          totalGhs: Math.round(qty * cost * 100) / 100,
        });
        total += qty * cost;
      }
      const { supplierId, supplierName } = await resolveSupplier(Number(ownerOrg) || 1, body.supplierId != null ? Number(body.supplierId) : null, String(body.supplierName || ""));
      if (!supplierName) return NextResponse.json({ success: false, error: "Choose a supplier (or type an ad-hoc name)." }, { status: 400 });
      const quoteNumber = await nextQuoteNumber(Number(ownerOrg) || 1);
      const [row] = await db
        .insert(supplierQuotes)
        .values({
          quoteNumber,
          ownerId: Number(ownerOrg) || 1,
          businessId,
          requisitionId: requisition ? Number(requisition.id) : null,
          supplierId,
          supplierName,
          lines,
          totalGhs: Math.round(total * 100) / 100,
          leadTimeDays: body.leadTimeDays != null && Number(body.leadTimeDays) > 0 ? Math.round(Number(body.leadTimeDays)) : null,
          paymentTerms: body.paymentTerms ? String(body.paymentTerms).slice(0, 40) : null,
          validUntil: String(body.validUntil || "").slice(0, 10) || null,
          notes: String(body.notes || "").trim().slice(0, 400) || null,
          status: "QUOTED",
          createdByName: me.name || "Staff",
          createdByRole: me.role || "WORKER",
        })
        .returning();
      await auditLog(me, "CREATE", "RECORD", `Quotation ${quoteNumber}`, "SUPPLIER_QUOTE", row.id, businessId, null, `${supplierName} — ${lines.length} line(s), GH₵ ${total.toFixed(2)}`, ownerOrg);
      return NextResponse.json({ success: true, quote: row });
    }

    // ── QUOTE_SELECT — award the quote; create the PO from its lines ──
    if (action === "QUOTE_SELECT") {
      const [quote] = await db.select().from(supplierQuotes).where(eq(supplierQuotes.id, Number(body.id)));
      if (!quote) return NextResponse.json({ success: false, error: "Quotation not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(quote.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (String(quote.status) !== "QUOTED") return NextResponse.json({ success: false, error: `A ${quote.status} quote cannot be selected.` }, { status: 409 });
      const now = new Date();
      const [updQuote] = await db
        .update(supplierQuotes)
        .set({ status: "SELECTED", selectedByName: me.name || "Staff", selectedAt: now })
        .where(eq(supplierQuotes.id, quote.id))
        .returning();
      // Reject the sibling quotes of the same requisition.
      if (quote.requisitionId != null) {
        await db
          .update(supplierQuotes)
          .set({ status: "REJECTED" })
          .where(and(eq(supplierQuotes.requisitionId, Number(quote.requisitionId)), eq(supplierQuotes.status, "QUOTED")));
      }
      // Build the PO from the quote's lines (inventory-mapped lines only can
      // post stock at GRN; lines without an inventoryId are rejected).
      const qLines = Array.isArray(quote.lines) ? (quote.lines as any[]) : [];
      const items: any[] = [];
      let total = 0;
      for (const li of qLines) {
        const invId = Number(li.inventoryId || 0);
        if (!invId) continue;
        const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, invId));
        if (!inv || Number(inv.businessId) !== Number(quote.businessId)) continue;
        const qty = Number(li.quantity) || 0;
        const cost = Math.max(0, Number(li.unitCostGhs) || 0);
        items.push({ inventoryId: inv.id, description: String(li.description || inv.name), qty, unitCostGhs: cost, trackingId: null });
        total += qty * cost;
      }
      if (!items.length) {
        return NextResponse.json({ success: false, error: "This quote has no lines mapped to the unit's stock catalogue — raise the PO manually." }, { status: 409 });
      }
      const ownerOrg = Number(quote.ownerId) || (await ownerOrgOfBusiness(Number(quote.businessId))) || 1;
      const [requisitionOfQuote] = quote.requisitionId != null
        ? await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, Number(quote.requisitionId)))
        : [null];
      const paymentMode = String(body.paymentMode || "ON_RECEIPT").toUpperCase() === "ON_CREDIT" ? "ON_CREDIT" : "ON_RECEIPT";
      const { uniquePurchaseNumber } = await import("@/lib/preorder");
      const pnum = await uniquePurchaseNumber();
      const poGate = await approvalGateCheck({ user: me, action: "PURCHASE_ORDER", businessId: Number(quote.businessId), amountGhs: Math.round(total * 100) / 100 });
      const [po] = await db
        .insert(supplierOrders)
        .values({
          purchaseNumber: pnum,
          ownerId: ownerOrg,
          businessId: Number(quote.businessId),
          branchCode: requisitionOfQuote ? requisitionOfQuote.branchCode : null,
          supplierId: quote.supplierId,
          supplierName: quote.supplierName,
          trackingLineIds: [],
          status: poGate.gated ? "PENDING_APPROVAL" : "RAISED",
          expectedAt: quote.leadTimeDays != null ? new Date(Date.now() + Number(quote.leadTimeDays) * 86400000).toISOString().slice(0, 10) : null,
          currency: "GHS",
          items,
          totalGhs: Math.round(total * 100) / 100,
          statusHistory: [{ status: poGate.gated ? "PENDING_APPROVAL" : "RAISED", at: now.toISOString(), by: me.name || "Staff", byRole: me.role || "WORKER", note: `From quotation ${quote.quoteNumber}` }],
          paymentMode,
          requisitionId: quote.requisitionId != null ? Number(quote.requisitionId) : null,
          notes: `Awarded from quotation ${quote.quoteNumber} (${quote.supplierName}).`,
          createdByUserId: me.id ?? null,
          createdByName: me.name || "Staff",
          createdByRole: me.role || "WORKER",
        })
        .returning();
      await db.update(supplierQuotes).set({ supplierOrderId: Number(po.id) }).where(eq(supplierQuotes.id, quote.id));
      if (quote.requisitionId != null) {
        await db
          .update(purchaseRequisitions)
          .set({ status: "ORDERED", supplierOrderId: Number(po.id), updatedAt: now })
          .where(eq(purchaseRequisitions.id, Number(quote.requisitionId)));
      }
      if (poGate.gated) {
        await createApprovalRequest({
          action: "PURCHASE_ORDER",
          businessId: Number(quote.businessId),
          targetType: "SUPPLIER_ORDER",
          targetId: Number(po.id),
          targetLabel: `PO ${pnum} — ${quote.supplierName}`,
          amountGhs: Math.round(total * 100) / 100,
          payloadSnapshot: { purchaseNumber: pnum, fromQuote: quote.quoteNumber },
          actor: me,
        });
      }
      await auditLog(me, "CREATE", "RECORD", `Supplier order ${pnum} (from ${quote.quoteNumber})`, "SUPPLIER_ORDER", po.id, Number(quote.businessId), null, `${items.length} line(s) totalling GH₵ ${total.toFixed(2)} with ${quote.supplierName} (${paymentMode})`, ownerOrg);
      return NextResponse.json({ success: true, quote: updQuote, order: po, pendingApproval: poGate.gated || undefined });
    }

    // ── INVOICE_REGISTER — book a supplier invoice against a PO ──
    if (action === "INVOICE_REGISTER") {
      const businessId = Number(body.businessId);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      const amount = Number(body.amountGhs) || 0;
      if (!(amount > 0)) return NextResponse.json({ success: false, error: "Invoice amount must be positive." }, { status: 400 });
      const invoiceNumber = String(body.invoiceNumber || "").trim().slice(0, 60);
      if (!invoiceNumber) return NextResponse.json({ success: false, error: "The supplier's invoice number is required." }, { status: 400 });
      const dup = await db.select({ id: supplierInvoices.id }).from(supplierInvoices).where(eq(supplierInvoices.invoiceNumber, invoiceNumber));
      if (dup.length) return NextResponse.json({ success: false, error: `Invoice ${invoiceNumber} is already registered.` }, { status: 409 });
      const ownerOrg = await ownerOrgOfBusiness(businessId);
      let po: any = null;
      if (body.supplierOrderId != null) {
        [po] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, Number(body.supplierOrderId)));
        if (!po || Number(po.businessId) !== businessId) {
          return NextResponse.json({ success: false, error: "That purchase order does not belong to this unit." }, { status: 400 });
        }
      }
      const { supplierId, supplierName } = await resolveSupplier(Number(ownerOrg) || 1, body.supplierId != null ? Number(body.supplierId) : (po?.supplierId ?? null), String(body.supplierName || po?.supplierName || ""));
      // 3-way match snapshot: PO total vs invoice, ordered vs received qty.
      let status = "PENDING";
      let matchResult: any = {};
      if (po) {
        const receipts = await db.select().from(goodsReceipts).where(eq(goodsReceipts.supplierOrderId, po.id));
        const orderedQty = (Array.isArray(po.items) ? (po.items as any[]) : []).reduce((s, li) => s + (Number(li.qty) || 0), 0);
        const receivedQty = receipts.reduce(
          (s, rc) => s + (Array.isArray(rc.items) ? (rc.items as any[]).reduce((x, li) => x + (Number(li.qty) || 0), 0) : 0),
          0,
        );
        const varianceGhs = Math.round((amount - Number(po.totalGhs)) * 100) / 100;
        status = Math.abs(varianceGhs) < 0.01 ? "MATCHED" : "VARIANCE";
        matchResult = {
          poNumber: po.purchaseNumber,
          poTotal: Number(po.totalGhs),
          invoiceTotal: amount,
          varianceGhs,
          orderedQty,
          receivedQty,
          varianceNote:
            Math.abs(varianceGhs) < 0.01
              ? "Invoice matches the purchase order."
              : `Invoice differs from PO ${po.purchaseNumber} by GH₵ ${Math.abs(varianceGhs).toFixed(2)} (${varianceGhs > 0 ? "over" : "under"}).`,
        };
      }
      const [row] = await db
        .insert(supplierInvoices)
        .values({
          invoiceNumber,
          ownerId: Number(ownerOrg) || 1,
          businessId,
          branchCode: body.branchCode || po?.branchCode || null,
          supplierOrderId: po ? Number(po.id) : null,
          supplierId,
          supplierName,
          invoiceDate: String(body.invoiceDate || "").slice(0, 10) || null,
          amountGhs: amount,
          status,
          matchResult,
          notes: String(body.notes || "").trim().slice(0, 400) || null,
          attachmentDocumentId: body.attachmentDocumentId != null ? Number(body.attachmentDocumentId) : null,
          paymentMode: String(body.paymentMode || po?.paymentMode || "ON_RECEIPT").toUpperCase() === "ON_CREDIT" ? "ON_CREDIT" : "ON_RECEIPT",
          registeredByName: me.name || "Staff",
          registeredByRole: me.role || "WORKER",
        })
        .returning();
      await auditLog(me, "CREATE", "RECORD", `Supplier invoice ${invoiceNumber}`, "SUPPLIER_INVOICE", row.id, businessId, null, `${supplierName} — GH₵ ${amount.toFixed(2)} (${status})`, ownerOrg);
      return NextResponse.json({ success: true, invoice: row });
    }

    // ── INVOICE_CANCEL ──
    if (action === "INVOICE_CANCEL") {
      const [inv] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, Number(body.id)));
      if (!inv) return NextResponse.json({ success: false, error: "Invoice not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(inv.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (Number(inv.amountPaidGhs) > 0) {
        return NextResponse.json({ success: false, error: "Partly-paid invoices cannot be cancelled — record the balance or adjust." }, { status: 409 });
      }
      const [row] = await db
        .update(supplierInvoices)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(supplierInvoices.id, inv.id))
        .returning();
      return NextResponse.json({ success: true, invoice: row });
    }

    // ── PAYMENT_RECORD — pay a supplier invoice (books ON_CREDIT expenses
    //    exactly once; ON_RECEIPT invoices were already expensed at GRN) ──
    if (action === "PAYMENT_RECORD") {
      const [inv] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, Number(body.id)));
      if (!inv) return NextResponse.json({ success: false, error: "Invoice not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(inv.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      if (["CANCELLED", "PAID"].includes(String(inv.status))) {
        return NextResponse.json({ success: false, error: `This invoice is ${inv.status}.` }, { status: 409 });
      }
      const amount = Number(body.amountGhs) || 0;
      if (!(amount > 0)) return NextResponse.json({ success: false, error: "Payment amount must be positive." }, { status: 400 });
      const outstanding = Math.round((Number(inv.amountGhs) - Number(inv.amountPaidGhs)) * 100) / 100;
      if (amount - outstanding > 0.01) {
        return NextResponse.json({ success: false, error: `Outstanding balance is GH₵ ${outstanding.toFixed(2)} — cannot pay more.` }, { status: 400 });
      }
      const paymentMethod = String(body.paymentMethod || "CASH").toUpperCase();
      if (!["CASH", "MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER", "POS_CARD"].includes(paymentMethod)) {
        return NextResponse.json({ success: false, error: "Unsupported payment method." }, { status: 400 });
      }
      const paidOn = String(body.paidOn || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const ownerOrg = Number(inv.ownerId) || (await ownerOrgOfBusiness(Number(inv.businessId))) || 1;

      // ON_CREDIT invoices: the payment IS the expense booking (the GRN
      // booked nothing). Exactly-once guard: the transaction is created in
      // the same insert chain as the payment row and linked by id.
      let transactionId: number | null = null;
      if (String(inv.paymentMode) === "ON_CREDIT") {
        const { postOrGateExpenseTransaction } = await import("@/lib/expensePosting");
        const expRes = await postOrGateExpenseTransaction({
          businessId: Number(inv.businessId),
          branchCode: inv.branchCode,
          branchName: null,
          category: "Supplier Payment",
          amountGhs: amount,
          paymentMethod,
          supplierId: inv.supplierId,
          description: `Supplier payment — ${inv.supplierName} invoice ${inv.invoiceNumber}`,
          date: paidOn,
          actor: me,
          targetLabel: `Supplier Payment (${inv.supplierName}) — GH₵ ${amount.toFixed(2)}`,
          metadata: { invoiceNumber: inv.invoiceNumber, supplierName: inv.supplierName },
        });
        transactionId = expRes.transaction ? Number(expRes.transaction.id) : null;
      }
      const [payment] = await db
        .insert(supplierPayments)
        .values({
          paymentNumber: nextPaymentNumber(),
          ownerId: ownerOrg,
          businessId: Number(inv.businessId),
          branchCode: inv.branchCode,
          invoiceId: Number(inv.id),
          supplierOrderId: inv.supplierOrderId != null ? Number(inv.supplierOrderId) : null,
          supplierName: inv.supplierName,
          amountGhs: amount,
          paymentMethod,
          reference: body.reference ? String(body.reference).slice(0, 80) : null,
          note: body.note ? String(body.note).slice(0, 300) : null,
          transactionId,
          paidOn,
          recordedByUserId: me.id ?? null,
          recordedByName: me.name || "Staff",
          recordedByRole: me.role || "WORKER",
        })
        .returning();
      const newPaid = Math.round((Number(inv.amountPaidGhs) + amount) * 100) / 100;
      const fullyPaid = newPaid >= Number(inv.amountGhs) - 0.01;
      const [row] = await db
        .update(supplierInvoices)
        .set({
          amountPaidGhs: newPaid,
          status: fullyPaid ? "PAID" : String(inv.status),
          updatedAt: new Date(),
        })
        .where(eq(supplierInvoices.id, inv.id))
        .returning();
      await auditLog(
        me,
        "CREATE",
        "RECORD",
        `Supplier payment ${payment.paymentNumber}`,
        "SUPPLIER_PAYMENT",
        payment.id,
        Number(inv.businessId),
        null,
        `GH₵ ${amount.toFixed(2)} to ${inv.supplierName} for invoice ${inv.invoiceNumber}${transactionId ? ` (expense booked)` : ""}`,
        ownerOrg,
      );
      return NextResponse.json({ success: true, payment, invoice: row, transactionId });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/procurement error:", error);
    return apiError(error);
  }
}
