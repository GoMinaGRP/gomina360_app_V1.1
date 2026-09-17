/**
 * Pre-Order server engine — one order system, enriched.
 *
 * Everything here rides EXISTING GoMina 360 primitives:
 *  · orders        → customer_trackings (orderKind PREORDER/MIXED + snapshot)
 *  · money         → transactions (INCOME per payment event: deposit/balance)
 *  · goods-in gate → goods_receipts (ONLY stock-in gate for pre-orders)
 *  · catalogue     → fulfillment_methods / fulfillment_options (seller config)
 *  · notifications → notifications bell + push (orderNotificationRecipients)
 *  · audit         → audit_trail per procurement milestone
 *  · scoping       → ownerId (organizations.id) + businessId + branchCode
 *
 * HARD RULE: pre-ordered goods never increment inventory_items.quantity
 * until a goods_receipt is posted. Customer demand ("on-order" units) stays
 * OUT of availability math.
 */

import { db } from "@/db";
import { deductOrderStock } from "@/lib/trackingServer";
import {
  auditTrail,
  customerTrackings,
  fulfillmentMethods,
  fulfillmentOptions,
  goodsReceipts,
  inventoryItems,
  notifications,
  orderPayments,
  supplierOrders,
  suppliers,
  transactions,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { orderNotificationRecipients, ownerOrgOfBusiness } from "@/lib/notify";
import { pushAfterBell } from "@/lib/push";
import { PREORDER_CHAIN, TRACK_STATUS_LABELS } from "@/lib/tracking";

export type PreorderMode = "STOCK" | "PREORDER" | "MIXED";

/** per-cart-line resolved preorder facts (server-derived, never client-trusted) */
export interface ResolvedLine {
  inventoryId: number;
  quantity: number;
  /** null = plain stock line (existing behaviour) */
  fulfill: null | {
    optionId: number;
    methodKey: string;
    methodLabel: string;
    priceGhs: number;
    leadMinDays: number;
    leadMaxDays: number;
    depositGhs: number; // per-total deposit required for THIS line
    termsKey: "ON_ARRIVAL" | "ON_FULFILLMENT";
  };
}

/** Deposit required for an option, per unit. */
export function optionDepositPerUnit(o: any): number {
  if (!o) return 0;
  if (o.depositType === "NONE") return Number(o.priceGhs) || 0;
  const price = Number(o.priceGhs) || 0;
  if (o.depositType === "PERCENT") return Math.round(((price * (Number(o.depositValue) || 0)) / 100) * 100) / 100;
  return Math.min(price, Number(o.depositValue) || 0); // FIXED
}

/** Terms label for customers + staff. */
export function termsLabel(termsKey: string, depositDueGhs: number): string {
  if (depositDueGhs <= 0) return "Pay in full now";
  if (termsKey === "ON_ARRIVAL") return "Deposit now — balance on arrival";
  return "Deposit now — balance when order is ready";
}

/**
 * Resolve pre-order fulfillment for a cart, STRICTLY server-side. Every
 * fulfillmentLine must point at an ACTIVE option of the same org+business+
 * inventory item, or the request is rejected outright. Returns null when the
 * cart has no fulfilment choices (a plain STOCK order — legacy path).
 */
export async function resolvePreorders({
  businessId,
  ownerOrg,
  cart,
  fulfilmentPicker, // { [inventoryId]: optionId } from the client
}: {
  businessId: number;
  ownerOrg: number | null;
  cart: { inventoryId: number; quantity: number }[];
  fulfilmentPicker: Record<string, number>;
}): Promise<{ lines: ResolvedLine[]; problems: string[] } | null> {
  const pickedInvIds = Object.keys(fulfilmentPicker || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (pickedInvIds.length === 0) return null;

  const inventoryIds = cart.map((li) => li.inventoryId).filter(Boolean);
  const options = inventoryIds.length
    ? await db
        .select()
        .from(fulfillmentOptions)
        .where(inArray(fulfillmentOptions.inventoryId, inventoryIds))
    : [];
  const active = options.filter((o) => o.active !== false);
  const problems: string[] = [];
  const lines: ResolvedLine[] = [];

  for (const li of cart) {
    const chosenId = Number(fulfilmentPicker[String(li.inventoryId)] || 0);
    if (!chosenId) {
      lines.push({ inventoryId: li.inventoryId, quantity: li.quantity, fulfill: null });
      continue;
    }
    const opt = active.find(
      (o) =>
        o.id === chosenId &&
        Number(o.inventoryId) === Number(li.inventoryId) &&
        Number(o.businessId) === Number(businessId) &&
        (ownerOrg == null || Number(o.ownerId) === Number(ownerOrg)),
    );
    if (!opt) {
      problems.push("One of your fulfilment choices is no longer available — please refresh and pick again.");
      continue;
    }
    const [method] = await db.select().from(fulfillmentMethods).where(eq(fulfillmentMethods.id, Number(opt.methodId)));
    if (!method || method.active === false) {
      problems.push("One of your chosen shipping methods is currently unavailable.");
      continue;
    }
    lines.push({
      inventoryId: li.inventoryId,
      quantity: li.quantity,
      fulfill: {
        optionId: opt.id,
        methodKey: String(method.key),
        methodLabel: String(method.label),
        priceGhs: Number(opt.priceGhs),
        leadMinDays: Number(opt.leadMinDays),
        leadMaxDays: Number(opt.leadMaxDays),
        depositGhs: optionDepositPerUnit(opt) * li.quantity,
        termsKey: opt.termsKey === "ON_ARRIVAL" ? "ON_ARRIVAL" : "ON_FULFILLMENT",
      },
    });
  }
  // Once any pick was made this is a preorder-resolution result — problems
  // MUST surface to the caller (a null here would silently degrade bad
  // or cross-tenant picks into STOCK lines). Empty lines + problems ⇒ 409.
  return { lines, problems };
}

/** Build the preorder snapshot saved onto the order row. */
export function buildPreorderSnapshot(resolved: ResolvedLine[]): any {
  const pres = resolved.filter((l) => l.fulfill);
  if (!pres.length) return null;
  const depositDueGhs = pres.reduce((a, l) => a + (l.fulfill?.depositGhs || 0), 0);
  const minLead = Math.min(...pres.map((l) => l.fulfill!.leadMinDays));
  const maxLead = Math.max(...pres.map((l) => l.fulfill!.leadMaxDays));
  const etaStart = addDaysIso(minLead);
  const etaEnd = addDaysIso(maxLead);
  return {
    depositDueGhs: round2(depositDueGhs),
    requiredNowGhs: round2(depositDueGhs),
    etaStart,
    etaEnd,
    leadMinDays: minLead,
    leadMaxDays: maxLead,
    termsKey: pres.every((l) => l.fulfill!.termsKey === "ON_ARRIVAL") ? "ON_ARRIVAL" : "ON_FULFILLMENT",
    methods: [...new Set(pres.map((l) => l.fulfill!.methodLabel))],
  };
}

function addDaysIso(days: number): string {
  const d = new Date(Date.now() + Math.max(0, days) * 86400000);
  return d.toISOString().split("T")[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Order kind from resolved lines. */
export function orderKindFor(resolved: ResolvedLine[] | null): "STOCK" | "PREORDER" | "MIXED" {
  if (!resolved || !resolved.length) return "STOCK";
  const pres = resolved.filter((l) => l.fulfill).length;
  if (pres === 0) return "STOCK";
  if (pres === resolved.length) return "PREORDER";
  return "MIXED";
}

/** Which stock lines commit at CONFIRMED vs at RECEIVED_STOCK. Preorder
 * lines NEVER commit before goods receipt honours (RECEIVED_STOCK). */
export function linesForCommit(row: any): any[] {
  const items = Array.isArray(row?.items) ? row.items : [];
  const kind = row?.orderKind || "STOCK";
  if (kind === "STOCK") return items;
  // For PREORDER/MIXED — line-level marker preorder:true gates the deduction
  return items.filter((li: any) => !li?.preorder);
}

export function preorderLinesForReceipt(row: any): any[] {
  const items = Array.isArray(row?.items) ? row.items : [];
  return items.filter((li: any) => li?.preorder);
}

// ─── PAYMENT EVENTS ─────────────────────────────────────────────────────────

/**
 * Book an order payment event (deposit / balance / full). Exactly one income
 * transaction per event — no duplicate or double-counted revenue possible
 * because the row + transaction are written together in one pass and every
 * repeat of the same event kind is refused by the caller first.
 */
export async function bookPaymentEvent({
  tracking,
  kind,
  amountGhs,
  method,
  paymentRef,
  staff,
  biz,
}: {
  tracking: any;
  kind: "DEPOSIT" | "BALANCE" | "FULL";
  amountGhs: number;
  method: "CASH" | "MTN_MOMO";
  paymentRef?: string | null;
  staff: { id?: number; name?: string; role?: string };
  biz: any;
}): Promise<{ paymentId: number; transactionId: number }> {
  const dateStr = new Date().toISOString().split("T")[0];
  const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  const label =
    kind === "DEPOSIT" ? "Order Deposit" : kind === "BALANCE" ? "Order Balance" : "Online Order Sale";
  const ownerId = biz?.ownerId != null ? Number(biz.ownerId) : await ownerOrgOfBusiness(tracking.businessId);
  const [trx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId: tracking.businessId,
      branchCode: tracking.branchCode || biz?.code || null,
      branchName: tracking.branchName || biz?.name || null,
      type: "INCOME",
      category: label,
      amountGhs,
      paymentMethod: method,
      customerId: tracking.customerId || null,
      description: `[ORDER:${tracking.trackingCode}] ${label} — ${tracking.customerName}`,
      date: dateStr,
      status: "COMPLETED",
      recordedBy: staff.name || "Staff",
      recordedByRole: staff.role || null,
      recordedByUserId: staff.id ?? null,
    })
    .returning();
  const [ev] = await db
    .insert(orderPayments)
    .values({
      trackingId: tracking.id,
      kind,
      amountGhs,
      method,
      paymentRef: paymentRef || null,
      transactionId: trx.id,
      businessId: tracking.businessId,
      branchCode: tracking.branchCode || null,
      ownerId,
      markedByUserId: staff.id ?? null,
      markedByName: staff.name || "Staff",
    })
    .returning();
  return { paymentId: ev.id, transactionId: trx.id };
}

// ─── SUPPLIER PROCUREMENT PIPELINE ─────────────────────────────────────────

export const SUPPLIER_ORDER_STATUSES = [
  "RAISED",
  "SENT",
  "SHIPPED",
  "IN_TRANSIT",
  "ARRIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type SupplierOrderStatus = (typeof SUPPLIER_ORDER_STATUSES)[number];

export const SUPPLIER_ORDER_NEXT: Record<SupplierOrderStatus, SupplierOrderStatus[]> = {
  RAISED: ["SENT", "CANCELLED"],
  SENT: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

/** Stage the linked customer order advances to when the supplier order hits
 *  this status. Customer always sees exactly the chain from the report. */
const PO_TO_ORDER_STAGE: Partial<Record<SupplierOrderStatus, string>> = {
  SHIPPED: "SHIPPED",
  IN_TRANSIT: "IN_TRANSIT",
  ARRIVED: "ARRIVED",
  RECEIVED: "RECEIVED_STOCK",
};

export async function uniquePurchaseNumber(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const n = `PO-SO-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
    const clash = await db
      .select({ id: supplierOrders.id })
      .from(supplierOrders)
      .where(eq(supplierOrders.purchaseNumber, n));
    if (!clash.length) return n;
  }
  return `PO-SO-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
}

export async function uniqueReceiptNumber(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const n = `GRN-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
    const clash = await db
      .select({ id: goodsReceipts.id })
      .from(goodsReceipts)
      .where(eq(goodsReceipts.receiptNumber, n));
    if (!clash.length) return n;
  }
  return `GRN-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
}

/** Push the supplier order stage onto linked customer orders (with history
 * + dedupe: a stage never inserts twice for the same order row). */
export async function propagatePoStage({
  po,
  status,
  staff,
  note,
}: {
  po: any;
  status: string;
  staff: { id?: number; name?: string; role?: string };
  note?: string;
}): Promise<void> {
  const target = PO_TO_ORDER_STAGE[status as SupplierOrderStatus];
  if (!target) return;
  const ids: number[] = Array.isArray(po.trackingLineIds) ? po.trackingLineIds : [];
  const trackingIds = [...new Set(ids.map((n: any) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!trackingIds.length) return;
  const rows = await db.select().from(customerTrackings).where(inArray(customerTrackings.id, trackingIds));
  const now = new Date();
  // Advance by the CUSTOMER-faced stage index (RECEIVED → RECEIVED_STOCK etc.)
  const poStageIndex = PREORDER_CHAIN.indexOf(target as any);
  for (const row of rows) {
    // Only advance a LINEAR chain forward — never backwards, never beyond.
    const curIndex = PREORDER_CHAIN.indexOf(row.status as any);
    if (curIndex < 0 || curIndex >= PREORDER_CHAIN.length - 1) continue;
    if (curIndex >= poStageIndex) continue; // already at/past this stage
    if (row.status === "CANCELLED" || ["DELIVERED", "COMPLETED"].includes(row.status)) continue;
    const history = [...(Array.isArray(row.statusHistory) ? (row.statusHistory as any[]) : [])];
    history.push({
      status: target,
      at: now.toISOString(),
      by: staff.name || "Staff",
      byRole: staff.role || "WORKER",
      note: note || `Goods ${(TRACK_STATUS_LABELS as any)[target] || target} via ${po.purchaseNumber}.`,
    });
    // Auto-advance preorder statuses on RECEIVED — a supplier receipt should
    // not silently leave the order at ARRIVED.
    let extra: any = { status: target as any, statusHistory: history, updatedAt: now };
    if (target === "RECEIVED_STOCK") {
      // Commit the PREORDER lines against the newly-landed stock right now
      // (the goods receipt just incremented inventory for them). Rest
      // of the chain (READY→DELIVERED) is staff-driven.
      const preorderLines = ((row.items as any[]) || []).filter((li: any) => li?.inventoryId && li?.preorder);
      if (preorderLines.length && row.stockCommitStage !== "RECEIVED_STOCK") {
        const stock = await deductOrderStock(preorderLines as any[]);
        if (!stock.ok) {
          // Stock clearly missing for this unit — surface as a warning in the
          // history but do NOT block the customer journey forward; ops sees
          // the shortage when they fulfil and can escalate via inventory.
          history.push({ status: "NOTE", at: now.toISOString(), by: staff.name || "Staff", byRole: staff.role || "WORKER", note: `Could not commit preorder stock: ${stock.problems.join(" ")}` });
          extra.statusHistory = history;
        } else {
          history.push({ status: "NOTE", at: now.toISOString(), by: staff.name || "Staff", byRole: staff.role || "WORKER", note: "Preorder items committed from incoming stock." });
          extra.stockCommitted = true;
          extra.stockCommitStage = "RECEIVED_STOCK";
          extra.statusHistory = history;
        }
      }
    }
    await db
      .update(customerTrackings)
      .set(extra)
      .where(eq(customerTrackings.id, row.id));
  }
}

/**
 * GOODS RECEIPT — the only stock gate for pre-ordered goods. Idempotent by
 * supplier order: a PO may only ever be RECEIVED once (second call → 409).
 * Increments inventory stock by the documented quantities WITHOUT touching
 * availability of OTHER units (businessIds are independent rows).
 */
export async function postGoodsReceipt({
  po,
  items,
  staff,
  notes,
}: {
  po: any; // supplier_orders row
  items?: any[] | null; // optional override of received quantities
  staff: { id?: number; name?: string; role?: string };
  notes?: string | null;
}): Promise<{ receiptId: string; receiptRecordId: number; problems: string[] }> {
  if (po.status !== "ARRIVED") {
    return { receiptId: "", receiptRecordId: 0, problems: ["Goods can only be received once the shipment is ARRIVED."] };
  }
  const chosenItems = Array.isArray(items) && items.length ? items : (Array.isArray(po.items) ? po.items : []);
  const problems: string[] = [];
  const receiptItems: any[] = [];
  for (const li of chosenItems) {
    const qty = Number(li.qty ?? li.quantity) || 0;
    if (qty <= 0) continue;
    const invId = Number(li.inventoryId || 0);
    if (!invId) { problems.push("One receipt line lacks an inventory reference."); continue; }
    // SCOPE: stock-in strictly lands in the PO's own business — never cross-unit.
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, invId));
    if (!inv || Number(inv.businessId) !== Number(po.businessId)) {
      problems.push(`Stock target for "${li.description || invId}" is not this unit's inventory.`);
      continue;
    }
    receiptItems.push({ inventoryId: inv.id, description: li.description || inv.name, qty });
  }
  if (problems.length) return { receiptId: "", receiptRecordId: 0, problems };

  const receiptNumber = await uniqueReceiptNumber();
  const ownerId = Number(po.ownerId) || (await ownerOrgOfBusiness(po.businessId)) || 1;

  for (const li of receiptItems) {
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, li.inventoryId));
    if (!inv) continue;
    const newQty = (Number(inv.quantity) || 0) + li.qty;
    await db
      .update(inventoryItems)
      .set({
        quantity: newQty,
        status: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= inv.minStockThreshold ? "LOW_STOCK" : "IN_STOCK",
      })
      .where(eq(inventoryItems.id, inv.id));
    li.newQty = newQty;
  }

  const [rec] = await db
    .insert(goodsReceipts)
    .values({
      receiptNumber,
      supplierOrderId: po.id,
      businessId: po.businessId,
      branchCode: po.branchCode || null,
      ownerId,
      items: receiptItems,
      notes: notes || null,
      receivedByUserId: staff.id ?? null,
      receivedByName: staff.name || "Staff",
    })
    .returning();

  // Supplier expense — booked exactly once alongside the receipt so Finance
  // shows the cost when the goods physically land.
  if (!po.expenseBooked && Number(po.totalGhs) > 0) {
    const dateStr = new Date().toISOString().split("T")[0];
    await db.insert(transactions).values({
      transactionNumber: `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
      businessId: po.businessId,
      branchCode: po.branchCode || null,
      branchName: null,
      type: "EXPENSE",
      category: "Supplier Procurement",
      amountGhs: Number(po.totalGhs) || 0,
      paymentMethod: "CASH",
      description: `[PO:${po.purchaseNumber}] Supplier order receivable — ${po.supplierName} (${po.shippingMethodKey || "custom"})`,
      date: dateStr,
      status: "COMPLETED",
      recordedBy: staff.name || "Staff",
      recordedByRole: staff.role || null,
      recordedByUserId: staff.id ?? null,
    });
  }
  return { receiptId: receiptNumber, receiptRecordId: rec.id, problems: [] };
}

/** Bell the branch team + owner when a preorder reaches a milestone. */
export async function notifyPreorderMilestone({
  businessId,
  code,
  milestone,
  detail,
}: {
  businessId: number;
  code: string;
  milestone: string;
  detail: string;
}): Promise<void> {
  try {
    const recipients = await orderNotificationRecipients(businessId);
    const pushed: number[] = [];
    for (const u of recipients) {
      const dupes = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(u.id)),
            eq(notifications.type, "PREORDER_MILESTONE"),
            eq(notifications.recordRef, `${code}:${milestone}`),
          ),
        )
        .limit(1);
      if (dupes.length) continue;
      await db.insert(notifications).values({
        userId: u.id,
        type: "PREORDER_MILESTONE",
        title: `Pre-order ${code} — ${milestone}`,
        body: detail,
        recordType: "customer_trackings",
        recordRef: `${code}:${milestone}`,
        businessId,
        actorName: "System",
        ownerId: await ownerOrgOfBusiness(Number(businessId)),
      });
      pushed.push(Number(u.id));
    }
    if (pushed.length) {
      pushAfterBell(pushed, {
        type: "PREORDER_MILESTONE",
        title: `Pre-order ${code} — ${milestone}`,
        body: detail,
        url: "/?tab=TRACKING",
      });
    }
  } catch (e) {
    console.error("notifyPreorderMilestone warning:", e);
  }
}

// ─── CATALOGUE (methods + options) management ──────────────────────────────

/** Default methods seeded per organization so sellers start with a rich set
 *  and rename/disable/extend as they wish. Nothing hard-coded afterwards. */
export const DEFAULT_FULFILLMENT_METHODS: any[] = [
  { key: "AIR", label: "Air Freight Import", icon: "plane", leadMin: 5, leadMax: 10 },
  { key: "SEA", label: "Sea Freight Import", icon: "ship", leadMin: 21, leadMax: 45 },
  { key: "ROAD", label: "Regional Road Haulage", icon: "truck", leadMin: 3, leadMax: 7 },
  { key: "LOCAL", label: "Local Delivery Courier", icon: "bike", leadMin: 1, leadMax: 3 },
  { key: "PICKUP", label: "Branch Pickup Reservation", icon: "store", leadMin: 1, leadMax: 5 },
];

export async function ensureDefaultMethods(ownerOrg: number | null, staff: { id?: number; name?: string } = {}) {
  if (ownerOrg == null) return;
  const existing = await db.select().from(fulfillmentMethods).where(eq(fulfillmentMethods.ownerId, ownerOrg));
  const have = new Set(existing.filter((m) => m.businessId == null).map((m) => String(m.key)));
  for (const dm of DEFAULT_FULFILLMENT_METHODS) {
    if (have.has(dm.key)) continue;
    await db.insert(fulfillmentMethods).values({
      ownerId: ownerOrg,
      businessId: null,
      key: dm.key,
      label: dm.label,
      icon: dm.icon,
      defaultLeadMinDays: dm.leadMin,
      defaultLeadMaxDays: dm.leadMax,
      createdByUserId: staff.id ?? null,
      createdByName: staff.name || "System",
    });
  }
}

/** Supplier names usable from the suppliers master + any ad-hoc names used
 *  on module purchase tables, deduped (integration with the CRM Suppliers). */
export async function supplierDirectory(ownerOrg: number | null): Promise<{ id: number | null; name: string }[]> {
  const rows = ownerOrg == null
    ? await db.select().from(suppliers)
    : await db.select().from(suppliers).where(eq(suppliers.ownerId, ownerOrg));
  const seen = new Set<string>();
  const out: { id: number | null; name: string }[] = [];
  for (const s of rows) {
    const n = String(s.name || "").trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push({ id: s.id, name: n });
  }
  return out;
}

/** Check whether a given inventory item currently has ACTIVE preorder options. */
export async function activeOptionsForInventory(inventoryIds: number[]): Promise<Map<number, any[]>> {
  if (!inventoryIds.length) return new Map();
  const rows = await db
    .select()
    .from(fulfillmentOptions)
    .where(and(inArray(fulfillmentOptions.inventoryId, inventoryIds), eq(fulfillmentOptions.active, true)));
  const methodIds = [...new Set(rows.map((r) => r.methodId))];
  const methods = methodIds.length
    ? await db.select().from(fulfillmentMethods).where(and(inArray(fulfillmentMethods.id, methodIds), eq(fulfillmentMethods.active, true)))
    : [];
  const byId = new Map(methods.map((m) => [m.id, m]));
  const out = new Map<number, any[]>();
  for (const r of rows) {
    const m = byId.get(Number(r.methodId));
    if (!m) continue;
    const list = out.get(Number(r.inventoryId)) || [];
    list.push({ ...r, method: m });
    out.set(Number(r.inventoryId), list);
  }
  return out;
}
