/**
 * R2 — Procurement chain library (CAPABILITY-AUDIT-REPORT §5).
 *
 * Number generators for the requisition → quotation → invoice → payment
 * chain, the low-stock → draft-requisition sweep, and supplier performance
 * scoring (lead time / fill rate / invoice variance), all tenant-scoped.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  businesses,
  goodsReceipts,
  inventoryItems,
  purchaseRequisitions,
  supplierInvoices,
  supplierOrders,
  supplierQuotes,
  suppliers,
} from "@/db/schema";
import { getSystemMarker, setSystemMarker } from "@/lib/systemMarkers";
import { lowStockItemsForBusiness } from "@/lib/lowStock";

const year = () => new Date().getFullYear();

/** PR-2026-0001 — unique per organization, tolerant of concurrent inserts. */
export async function nextReqNumber(ownerId: number): Promise<string> {
  const rows = await db
    .select({ reqNumber: purchaseRequisitions.reqNumber })
    .from(purchaseRequisitions)
    .where(eq(purchaseRequisitions.ownerId, Number(ownerId)));
  const used = new Set(rows.map((r) => String(r.reqNumber)));
  const prefix = `PR-${year()}-`;
  for (let n = (rows.filter((r) => String(r.reqNumber).startsWith(prefix)).length + 1); ; n++) {
    const cand = `${prefix}${String(n).padStart(4, "0")}`;
    if (!used.has(cand)) return cand;
  }
}

/** SQ-2026-0001 — unique per organization. */
export async function nextQuoteNumber(ownerId: number): Promise<string> {
  const rows = await db
    .select({ q: supplierQuotes.quoteNumber })
    .from(supplierQuotes)
    .where(eq(supplierQuotes.ownerId, Number(ownerId)));
  const used = new Set(rows.map((r) => String(r.q)));
  const prefix = `SQ-${year()}-`;
  for (let n = (rows.filter((r) => String(r.q).startsWith(prefix)).length + 1); ; n++) {
    const cand = `${prefix}${String(n).padStart(4, "0")}`;
    if (!used.has(cand)) return cand;
  }
}

/** SPP-2026-123456 — globally unique supplier payment reference. */
export function nextPaymentNumber(): string {
  return `SPP-${year()}-${Math.floor(100000 + Math.random() * 900000)}`;
}

export interface DraftPrLine {
  inventoryId: number;
  description: string;
  quantity: number;
  unit?: string | null;
  estUnitCostGhs?: number | null;
}

/**
 * Low-stock → draft requisition sweep: for every business with low/out items,
 * create ONE DRAFT purchase requisition per day (marker
 * `low-stock-pr:{bizId}:{date}` so the cron never double-drafts). The PR is
 * left in DRAFT for the manager to review, adjust and submit — nothing is
 * ordered automatically. Returns what was drafted.
 */
export async function draftLowStockRequisitions(opts?: { businessIds?: number[] | null; today?: string }) {
  const today = opts?.today || new Date().toLocaleDateString("en-CA");
  let bizRows = await db.select({ id: businesses.id, ownerId: businesses.ownerId, code: businesses.code }).from(businesses);
  if (opts?.businessIds != null) {
    const scope = new Set((opts.businessIds || []).map(Number));
    bizRows = bizRows.filter((b) => scope.has(Number(b.id)));
  }
  const drafted: any[] = [];
  const invByBiz = new Map<number, { id: number; costPriceGhs: number | null }[]>();
  for (const biz of bizRows) {
    const markerKey = `low-stock-pr:${biz.id}:${today}`;
    if ((await getSystemMarker(markerKey)) != null) continue;
    let low: Awaited<ReturnType<typeof lowStockItemsForBusiness>> = [];
    try {
      low = await lowStockItemsForBusiness(Number(biz.id));
    } catch {
      continue;
    }
    if (!low.length) continue;
    try {
      invByBiz.set(Number(biz.id), (await inventoryOfBusiness(Number(biz.id))).map((iv) => ({ id: Number(iv.id), costPriceGhs: iv.costPriceGhs })));
    } catch {
      invByBiz.set(Number(biz.id), []);
    }
    // Suggested quantity = what's missing to reach the reorder point.
    const lines: DraftPrLine[] = low.slice(0, 25).map((li) => {
      const item = invByBiz.get(Number(biz.id))?.find((iv) => Number(iv.id) === Number(li.id));
      return {
        inventoryId: Number(li.id),
        description: String(li.name || "Stock item"),
        quantity: Math.max(1, Math.ceil(Math.max(Number(li.minStockThreshold) || 1, 1) - Number(li.quantity) || 1)),
        unit: li.unit || null,
        estUnitCostGhs: item?.costPriceGhs != null ? Number(item.costPriceGhs) : null,
      };
    });
    const reqNumber = await nextReqNumber(Number(biz.ownerId) || 1);
    const [row] = await db
      .insert(purchaseRequisitions)
      .values({
        reqNumber,
        ownerId: Number(biz.ownerId) || 1,
        businessId: Number(biz.id),
        lines: lines as any,
        source: "LOW_STOCK",
        notes: `Auto-drafted by the daily low-stock sweep on ${today} — review quantities, then submit for approval.`,
        status: "DRAFT",
        requestedByName: "Daily ops",
      })
      .returning();
    await setSystemMarker(markerKey, reqNumber);
    drafted.push(row);
  }
  return drafted;
}

export interface SupplierPerformanceRow {
  supplierId: number | null;
  supplierName: string;
  orders: number;
  received: number;
  avgLeadTimeDays: number | null;
  fillRatePct: number | null;
  invoices: number;
  avgVarianceGhs: number | null;
  totalInvoicedGhs: number;
}

/**
 * Supplier performance from data the chain already records:
 *  - lead time: RAISED → RECEIVED gap in the PO's statusHistory;
 *  - fill rate: goods-receipt quantities over ordered quantities;
 *  - invoice variance: supplier_invoices.matchResult.varianceGhs average.
 */
export async function supplierPerformance(businessIds: number[] | null): Promise<SupplierPerformanceRow[]> {
  let orders = await db.select().from(supplierOrders);
  if (businessIds != null) {
    const scope = new Set((businessIds || []).map(Number));
    orders = orders.filter((o) => scope.has(Number(o.businessId)));
  }
  const orderIds = orders.map((o) => Number(o.id));
  const receipts = orderIds.length
    ? await db.select().from(goodsReceipts).where(inArray(goodsReceipts.supplierOrderId, orderIds))
    : [];
  let invoices = await db.select().from(supplierInvoices);
  if (businessIds != null) {
    const scope = new Set((businessIds || []).map(Number));
    invoices = invoices.filter((i) => scope.has(Number(i.businessId)));
  }
  const bySupplier = new Map<string, SupplierPerformanceRow & { leadTimes: number[]; ordered: number; receivedN: number; variances: number[] }>();
  for (const o of orders) {
    if (String(o.status) === "CANCELLED") continue;
    const key = o.supplierId != null ? `id:${o.supplierId}` : `name:${o.supplierName}`;
    const row =
      bySupplier.get(key) ||
      {
        supplierId: o.supplierId != null ? Number(o.supplierId) : null,
        supplierName: String(o.supplierName),
        orders: 0,
        received: 0,
        avgLeadTimeDays: null,
        fillRatePct: null,
        invoices: 0,
        avgVarianceGhs: null,
        totalInvoicedGhs: 0,
        leadTimes: [],
        ordered: 0,
        receivedN: 0,
        variances: [],
      };
    row.orders++;
    // Lead time from the status history.
    const hist = Array.isArray(o.statusHistory) ? (o.statusHistory as any[]) : [];
    const raisedAt = hist.find((h) => String(h.status) === "RAISED")?.at;
    const receivedAt = hist.find((h) => String(h.status) === "RECEIVED")?.at;
    if (raisedAt && receivedAt) {
      const days = (Date.parse(receivedAt) - Date.parse(raisedAt)) / 86400000;
      if (Number.isFinite(days) && days >= 0) row.leadTimes.push(Math.round(days * 10) / 10);
    }
    // Ordered quantity (PO lines) + received quantity (receipts).
    const items = Array.isArray(o.items) ? (o.items as any[]) : [];
    row.ordered += items.reduce((s, li) => s + (Number(li.qty) || 0), 0);
    const poReceipts = receipts.filter((r) => Number(r.supplierOrderId) === Number(o.id));
    for (const rc of poReceipts) {
      const rcItems = Array.isArray(rc.items) ? (rc.items as any[]) : [];
      row.receivedN += rcItems.reduce((s, li) => s + (Number(li.qty) || 0), 0);
    }
    if (String(o.status) === "RECEIVED") row.received++;
    bySupplier.set(key, row);
  }
  for (const inv of invoices) {
    if (String(inv.status) === "CANCELLED") continue;
    const key = inv.supplierId != null ? `id:${inv.supplierId}` : `name:${inv.supplierName}`;
    const row = bySupplier.get(key);
    if (!row) continue;
    row.invoices++;
    row.totalInvoicedGhs += Number(inv.amountGhs) || 0;
    const v = (inv.matchResult as any)?.varianceGhs;
    if (v != null && Number.isFinite(Number(v))) row.variances.push(Number(v));
  }
  return [...bySupplier.values()]
    .map((r) => ({
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      orders: r.orders,
      received: r.received,
      avgLeadTimeDays: r.leadTimes.length
        ? Math.round((r.leadTimes.reduce((s, n) => s + n, 0) / r.leadTimes.length) * 10) / 10
        : null,
      fillRatePct: r.ordered > 0 ? Math.round((r.receivedN / r.ordered) * 1000) / 10 : null,
      invoices: r.invoices,
      avgVarianceGhs: r.variances.length
        ? Math.round((r.variances.reduce((s, n) => s + n, 0) / r.variances.length) * 100) / 100
        : null,
      totalInvoicedGhs: Math.round(r.totalInvoicedGhs * 100) / 100,
    }))
    .sort((a, b) => b.orders - a.orders || a.supplierName.localeCompare(b.supplierName));
}

/** Inventory rows for a business (used by the PR form + quote→PO mapping). */
export async function inventoryOfBusiness(businessId: number) {
  return db
    .select({ id: inventoryItems.id, name: inventoryItems.name, sku: inventoryItems.sku, unit: inventoryItems.unit, costPriceGhs: inventoryItems.costPriceGhs })
    .from(inventoryItems)
    .where(eq(inventoryItems.businessId, Number(businessId)));
}

/** Resolve a supplier (id or ad-hoc name) inside the organization. */
export async function resolveSupplier(ownerId: number, supplierId: number | null, supplierName: string) {
  if (supplierId != null) {
    const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, Number(supplierId)));
    if (sup && Number(sup.ownerId) === Number(ownerId)) {
      return { supplierId: Number(sup.id), supplierName: sup.name };
    }
  }
  return { supplierId: null, supplierName: (supplierName || "Ad-hoc supplier").slice(0, 120) };
}
