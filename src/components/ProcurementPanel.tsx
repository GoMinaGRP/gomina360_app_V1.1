"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import UnitScopeOptions from "@/components/UnitScopeOptions";
import {
  ArrowRight,
  Factory,
  Plus,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";

/**
 * Procurement pipeline — the full R2 chain:
 *  Requisitions (draft → approve) → supplier Quotes (compare → award) →
 *  Purchase orders (advance → GRN) → Invoices (3-way match) → Payments
 *  (ON_CREDIT books the expense exactly once) + supplier performance.
 * The original pre-order → PO → GRN flow is unchanged on the Orders tab.
 */

const PO_STATUS_LABELS: Record<string, string> = {
  RAISED: "Raised",
  SENT: "Sent to supplier",
  SHIPPED: "Shipped",
  IN_TRANSIT: "In transit",
  ARRIVED: "Arrived",
  RECEIVED: "Received into stock",
  CANCELLED: "Cancelled",
};

const PO_NEXT: Record<string, string> = {
  RAISED: "SENT",
  SENT: "SHIPPED",
  SHIPPED: "IN_TRANSIT",
  IN_TRANSIT: "ARRIVED",
  ARRIVED: "RECEIVED",
};

const STATUS_BADGE: Record<string, string> = {
  RAISED: "bg-slate-600/40 text-slate-300 border-slate-500/40",
  SENT: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  SHIPPED: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  IN_TRANSIT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  ARRIVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  RECEIVED: "bg-green-500/15 text-green-300 border-green-500/30",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export default function ProcurementPanel({
  scopedBusinesses,
}: {
  scopedBusinesses: any[];
}) {
  const [bizId, setBizId] = useState<string>(scopedBusinesses[0] ? String(scopedBusinesses[0].id) : "");
  const [register, setRegister] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showRaise, setShowRaise] = useState(false);
  const [raiseDraft, setRaiseDraft] = useState<any>({ lines: [] });
  const [pendingOrders, setPendingOrders] = useState<any[]>([]);
  const [tab, setTab] = useState<"ORDERS" | "REQUISITIONS" | "QUOTES" | "INVOICES" | "SUPPLIERS">("ORDERS");
  const [showReq, setShowReq] = useState(false);
  const [reqDraft, setReqDraft] = useState<any>({ lines: [] });
  const [quoteFor, setQuoteFor] = useState<any>(null);
  const [quoteDraft, setQuoteDraft] = useState<any>({ lines: [] });
  const [invoiceFor, setInvoiceFor] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(bizId ? `/api/procurement?businessId=${bizId}` : "/api/procurement", { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        setRegister(d);
        setError("");
      } else {
        setError(d?.error || "Could not load procurement register.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => { load(); }, [load]);

  // Preorders waiting to be raised (orderKind != STOCK, status PREORDER/CONFIRMED).
  const loadPendingPreorders = useCallback(async () => {
    try {
      const res = await fetch(`/api/tracking${bizId ? `?businessId=${bizId}` : ""}`, { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        const pending = (d.trackings || []).filter(
          (t: any) => (t.orderKind || "STOCK") !== "STOCK" && ["PREORDER", "CONFIRMED", "RECEIVED"].includes(t.status) && !t.supplierOrderId,
        );
        setPendingOrders(pending);
      }
    } catch {}
  }, [bizId]);

  useEffect(() => { loadPendingPreorders(); }, [loadPendingPreorders, register]);

  // Escape key handler for modal dialogs
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showReq) setShowReq(false);
        else if (quoteFor !== null) setQuoteFor(null);
        else if (invoiceFor) setInvoiceFor(null);
        else if (showRaise) setShowRaise(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showReq, quoteFor, invoiceFor, showRaise]);

  const api = async (payload: any) => {
    const res = await fetch("/api/procurement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!d?.success) throw new Error(d?.error || "Action failed.");
    return d;
  };

  const suppliers = useMemo(() => register?.suppliers || [], [register]);
  const orders = useMemo(() => register?.orders || [], [register]);

  const buildLinesFromOrders = (picked: any[]) => {
    const map = new Map<string, any>();
    for (const o of picked) {
      for (const li of (o.items || [])) {
        if (!li?.inventoryId || !li?.preorder) continue;
        const k = String(li.inventoryId);
        const prev = map.get(k) || { inventoryId: li.inventoryId, productName: li.name, quantity: 0, unitCostGhs: 0 };
        prev.quantity += Number(li.quantity || 0);
        map.set(k, prev);
      }
    }
    return [...map.values()];
  };

  const raisePO = async () => {
    setBusy(true);
    setError("");
    try {
      await api({
        action: "RAISE",
        businessId: Number(bizId),
        supplierId: Number(raiseDraft.supplierId),
        trackingIds: raiseDraft.trackingIds || [],
        lines: raiseDraft.lines,
        expectedAt: raiseDraft.expectedAt || null,
        note: raiseDraft.note || "",
      });
      setShowRaise(false);
      setRaiseDraft({ lines: [] });
      setFlash("Purchase order submitted to the supplier.");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const advance = async (poId: number) => {
    setBusy(true);
    setError("");
    try {
      const next = PO_NEXT[String(orders.find((o: any) => o.id === poId)?.status || "")];
      if (!next) throw new Error("This purchase order cannot be advanced.");
      await api({ action: "ADVANCE", businessId: Number(bizId), id: poId, status: next });
      setFlash(`Purchase order moved to ${PO_STATUS_LABELS[next]}.`);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const receive = async (po: any) => {
    const ref = window.prompt(
      `Post goods receipt for ${po.purchaseOrderNumber}?\n\nEach line's quantity lands into the branch inventory (pre-order items stay committed to their customers).\n\nEnter a GRN reference (optional):`,
      "",
    );
    if (ref === null) return;
    setBusy(true);
    setError("");
    try {
      await api({ action: "RECEIVE", businessId: Number(bizId), id: po.id, reference: ref.trim() || null });
      setFlash("Goods receipt posted — stock booked, supplier expense recorded.");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (po: any) => {
    if (!window.confirm(`Cancel ${po.purchaseOrderNumber}? Linked customer orders keep their stage.`)) return;
    setBusy(true);
    setError("");
    try {
      await api({ action: "CANCEL", businessId: Number(bizId), id: po.id });
      setFlash("Purchase order cancelled.");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const requisitions = useMemo(() => register?.requisitions || [], [register]);
  const quotes = useMemo(() => register?.quotes || [], [register]);
  const invoices = useMemo(() => register?.invoices || [], [register]);
  const inventory = useMemo(() => register?.inventory || [], [register]);
  const performance = useMemo(() => register?.supplierPerformance || [], [register]);

  const TABS = [
    { id: "ORDERS", label: "Orders" },
    { id: "REQUISITIONS", label: `Requisitions${requisitions.filter((r: any) => ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(r.status)).length ? ` (${requisitions.filter((r: any) => ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(r.status)).length})` : ""}` },
    { id: "QUOTES", label: "Quotes" },
    { id: "INVOICES", label: `Invoices & Payments${invoices.filter((i: any) => !["PAID", "CANCELLED"].includes(i.status)).length ? ` (${invoices.filter((i: any) => !["PAID", "CANCELLED"].includes(i.status)).length})` : ""}` },
    { id: "SUPPLIERS", label: "Suppliers" },
  ] as const;

  const invItem = (id: number) => inventory.find((i: any) => Number(i.id) === Number(id));

  // ── R2 chain actions ──
  const saveRequisition = async () => {
    setBusy(true); setError("");
    try {
      await api({
        action: "REQUISITION_CREATE",
        businessId: Number(bizId),
        lines: reqDraft.lines,
        needBy: reqDraft.needBy || null,
        notes: reqDraft.notes || "",
      });
      setShowReq(false); setReqDraft({ lines: [] });
      setFlash("Requisition drafted. Review it, then submit for approval.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const submitRequisition = async (pr: any) => {
    if (!window.confirm(`Submit ${pr.reqNumber} for approval?`)) return;
    setBusy(true); setError("");
    try {
      const d = await api({ action: "REQUISITION_SUBMIT", id: pr.id });
      setFlash(d?.pendingApproval ? `${pr.reqNumber} is awaiting approval — check the Action Center inbox.` : `${pr.reqNumber} approved (no policy gate for this amount).`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const cancelRequisition = async (pr: any) => {
    if (!window.confirm(`Cancel requisition ${pr.reqNumber}?`)) return;
    setBusy(true); setError("");
    try {
      await api({ action: "REQUISITION_CANCEL", id: pr.id });
      setFlash(`Requisition ${pr.reqNumber} cancelled.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const openQuoteForm = (pr: any) => {
    if (!bizId) { setError("Choose a business unit first."); return; }
    setQuoteFor(pr);
    setQuoteDraft({
      supplierId: "",
      supplierName: "",
      leadTimeDays: pr?.needBy ? 7 : 3,
      paymentTerms: "Net 0",
      validUntil: "",
      lines: (pr?.lines || []).map((li: any) => ({
        inventoryId: li.inventoryId,
        description: li.description,
        quantity: li.quantity,
        unitCostGhs: li.estUnitCostGhs || invItem(li.inventoryId)?.costPriceGhs || 0,
      })),
    });
  };

  const saveQuote = async () => {
    setBusy(true); setError("");
    try {
      await api({
        action: "QUOTE_ADD",
        businessId: Number(bizId),
        requisitionId: quoteFor?.id || null,
        supplierId: quoteDraft.supplierId ? Number(quoteDraft.supplierId) : null,
        supplierName: quoteDraft.supplierName || "",
        lines: quoteDraft.lines,
        leadTimeDays: Number(quoteDraft.leadTimeDays) || null,
        paymentTerms: quoteDraft.paymentTerms || null,
        validUntil: quoteDraft.validUntil || null,
      });
      setQuoteFor(null); setQuoteDraft({ lines: [] });
      setFlash("Quotation registered.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const selectQuote = async (q: any) => {
    const mode = window.prompt(`Award ${q.quoteNumber} to ${q.supplierName}?\n\nPayment mode — type ON_CREDIT to defer the expense to payment, or leave blank for ON_RECEIPT (expensed at goods receipt):`, "") || "";
    if (mode === null) return;
    setBusy(true); setError("");
    try {
      const d = await api({ action: "QUOTE_SELECT", id: q.id, paymentMode: mode.trim().toUpperCase() === "ON_CREDIT" ? "ON_CREDIT" : "ON_RECEIPT" });
      setFlash(d?.pendingApproval ? `PO ${d?.order?.purchaseNumber || ""} raised from ${q.quoteNumber} — awaiting approval.` : `PO ${d?.order?.purchaseNumber || ""} raised from ${q.quoteNumber}. Sibling quotes rejected.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const saveInvoice = async () => {
    setBusy(true); setError("");
    try {
      await api({
        action: "INVOICE_REGISTER",
        businessId: Number(bizId),
        supplierOrderId: invoiceFor?.id || null,
        invoiceNumber: invoiceFor?.invoiceNumber || "",
        invoiceDate: invoiceFor?.invoiceDate || "",
        amountGhs: Number(invoiceFor?.amountGhs || 0),
        notes: invoiceFor?.notes || "",
      });
      setInvoiceFor(null);
      setFlash("Invoice registered and matched against the purchase order.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const payInvoice = async (inv: any) => {
    const outstanding = Math.max(0, Number(inv.amountGhs || 0) - Number(inv.amountPaidGhs || 0));
    const amount = window.prompt(`Pay ${inv.supplierName} invoice ${inv.invoiceNumber}\nOutstanding: GH₵ ${outstanding.toFixed(2)}\n\nAmount to pay (GH₵):`, outstanding.toFixed(2));
    if (amount === null) return;
    const method = window.prompt("Payment method (CASH, MTN_MOMO, TELECEL_CASH, BANK_TRANSFER, POS_CARD):", "CASH");
    if (!method) return;
    setBusy(true); setError("");
    try {
      const d = await api({ action: "PAYMENT_RECORD", id: inv.id, amountGhs: Number(amount), paymentMethod: method.trim().toUpperCase() });
      setFlash(d?.transactionId ? `Payment recorded — expense booked once (ON_CREDIT).` : "Payment recorded.");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const pendingTotal = pendingOrders.length;

  return (
    <div className="space-y-4" data-testid="proc-root">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <div>
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Factory className="w-4 h-4 text-amber-400" /> Procurement Pipeline
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Raise supplier purchase orders for pre-order commitments and watch the chain —
            Submitted → Confirmed → Shipped → In Transit → Arrived → Received. Customer pre-orders follow each step automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={bizId} onChange={(e) => setBizId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200" data-testid="proc-biz">
            <UnitScopeOptions units={scopedBusinesses} />
          </select>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" data-testid="proc-refresh"><RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /></button>
          <button onClick={() => { setRaiseDraft({ lines: [], supplierId: "", trackingIds: [] }); setShowRaise(true); }} disabled={!bizId || !suppliers.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-raise">
            <Plus className="w-3.5 h-3.5" /> Raise PO{pendingTotal ? ` (${pendingTotal} waiting)` : ""}
          </button>
        </div>
      </div>

      {flash && <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2" data-testid="proc-flash">{flash}</p>}
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="proc-error">{error}</p>}

      <div className="flex flex-wrap gap-1.5" data-testid="proc-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as any)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${tab === t.id ? "bg-amber-600 text-white border-amber-500" : "bg-slate-800/70 text-slate-300 border-slate-700 hover:bg-slate-700/60"}`}
            data-testid={`proc-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "ORDERS" && (
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
          <h4 className="text-xs font-extrabold text-white">Purchase orders</h4>
          <span className="text-[10px] text-slate-500">{orders.length} total · {orders.filter((o: any) => !["RECEIVED", "CANCELLED"].includes(o.status)).length} active</span>
        </div>
        <div className="divide-y divide-slate-700/40" data-testid="proc-orders">
          {orders.map((po: any) => {
            const isOpen = expanded === po.id;
            const nextLabel = PO_NEXT[po.status] ? PO_STATUS_LABELS[PO_NEXT[po.status]] : null;
            return (
              <div key={po.id} data-testid={`proc-po-${po.id}`}>
                <button
                  onClick={() => setExpanded(isOpen ? null : po.id)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-700/30 flex flex-wrap items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white font-mono">{po.purchaseOrderNumber}</p>
                    <p className="text-[10px] text-slate-500">
                      {po.supplierName} · raised {new Date(po.createdAt).toLocaleDateString()}
                      {po.expectedAt ? ` · expected ${new Date(po.expectedAt).toLocaleDateString()}` : ""}
                      {po.linkedOrders ? ` · ${po.linkedOrders} customer pre-order${po.linkedOrders === 1 ? "" : "s"}` : ""}
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${STATUS_BADGE[po.status] || "bg-slate-600 text-slate-300 border-slate-500"}`}>
                    {PO_STATUS_LABELS[po.status] || po.status}
                  </span>
                  <span className="text-xs font-black text-amber-300">GH₵ {Number(po.totalGhs || 0).toFixed(2)}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 space-y-3 border-t border-slate-700/40 pt-3">
                    <div>
                      <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Lines</p>
                      <div className="space-y-1">
                        {(po.items || []).map((li: any, idx: number) => (
                          <div key={idx} className="flex items-center justify-between text-[11px] text-slate-300 bg-slate-900/60 rounded-lg px-3 py-1.5">
                            <span>{li.productName || `Product #${li.inventoryId}`} × {li.quantity}</span>
                            <span className="font-mono">GH₵ {Number(li.lineTotalGhs || 0).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {(po.statusHistory || []).length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Trail</p>
                        <ul className="space-y-1 text-[10px] text-slate-400">
                          {[...(po.statusHistory as any[])].reverse().map((h: any, idx: number) => (
                            <li key={idx}>
                              <span className="text-slate-500">{new Date(h.at).toLocaleString()}</span> — <b className="text-slate-300">{PO_STATUS_LABELS[h.status] || h.status}</b> by {h.by}
                              {h.note ? ` — ${h.note}` : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {nextLabel && po.status !== "ARRIVED" && (
                        <button onClick={() => advance(po.id)} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-advance-${po.id}`}>
                          Advance: {nextLabel} <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                      {po.status === "ARRIVED" && (
                        <button onClick={() => receive(po)} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-receive-${po.id}`}>
                          <Truck className="w-3 h-3" /> Post goods receipt
                        </button>
                      )}
                      {!["RECEIVED", "CANCELLED", "ARRIVED"].includes(po.status) && (
                        <button onClick={() => cancel(po)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-bold disabled:opacity-50" data-testid={`proc-cancel-${po.id}`}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {orders.length === 0 && (
            <p className="px-4 py-6 text-xs text-slate-500">
              No purchase orders yet. Raise one to consolidate waiting pre-order commitments.
            </p>
          )}
        </div>
      </div>
      )}

      {/* ══════════ REQUISITIONS ══════════ */}
      {tab === "REQUISITIONS" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-white">Purchase requisitions</h4>
            <button onClick={() => { setReqDraft({ lines: [] }); setShowReq(true); }} disabled={!bizId || !inventory.length} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid="proc-new-req">
              <Plus className="w-3 h-3" /> New requisition
            </button>
          </div>
          <div className="divide-y divide-slate-700/40" data-testid="proc-requisitions">
            {requisitions.map((pr: any) => (
              <div key={pr.id} data-testid={`proc-req-${pr.id}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-bold text-white font-mono flex-1">{pr.reqNumber}</p>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                    pr.status === "APPROVED" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : pr.status === "PENDING_APPROVAL" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : pr.status === "ORDERED" ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
                    : pr.status === "CANCELLED" ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                    : "bg-slate-600/40 text-slate-300 border-slate-500/40"}`}>
                    {pr.status === "PENDING_APPROVAL" ? "Pending approval" : pr.status}
                  </span>
                  {pr.source === "LOW_STOCK" && <span className="text-[10px] font-bold text-orange-300 bg-orange-500/10 border border-orange-500/30 px-2 py-1 rounded-full">low-stock</span>}
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {pr.requestedByName} · {new Date(pr.createdAt).toLocaleDateString()}{pr.needBy ? ` · needed by ${new Date(pr.needBy).toLocaleDateString()}` : ""}
                  {pr.approvedByName ? ` · approved by ${pr.approvedByName}` : ""}
                  {pr.supplierOrderId ? ` · PO linked` : ""}
                </p>
                <div className="mt-2 space-y-1">
                  {(pr.lines || []).map((li: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-[11px] text-slate-300 bg-slate-900/60 rounded-lg px-3 py-1.5">
                      <span>{li.description} × {li.quantity}{li.unit ? ` ${li.unit}` : ""}</span>
                      <span className="font-mono">{li.estUnitCostGhs ? `~GH₵ ${(li.estUnitCostGhs * li.quantity).toFixed(2)}` : "—"}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {pr.status === "DRAFT" && (
                    <>
                      <button onClick={() => submitRequisition(pr)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-req-submit-${pr.id}`}>Submit for approval</button>
                      <button onClick={() => cancelRequisition(pr)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-bold disabled:opacity-50">Cancel</button>
                    </>
                  )}
                  {pr.status === "APPROVED" && (
                    <button onClick={() => openQuoteForm(pr)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-req-quote-${pr.id}`}>Add supplier quote</button>
                  )}
                </div>
              </div>
            ))}
            {requisitions.length === 0 && (
              <p className="px-4 py-6 text-xs text-slate-500">No requisitions yet. Draft one from the catalogue, or let the daily low-stock sweep draft them for you.</p>
            )}
          </div>
        </div>
      )}

      {/* ══════════ QUOTES ══════════ */}
      {tab === "QUOTES" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-white">Supplier quotations</h4>
            <button onClick={() => openQuoteForm(null)} disabled={!bizId || !inventory.length} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid="proc-new-quote">
              <Plus className="w-3 h-3" /> Ad-hoc quote
            </button>
          </div>
          <div className="divide-y divide-slate-700/40" data-testid="proc-quotes">
            {quotes.map((q: any) => (
              <div key={q.id} data-testid={`proc-quote-${q.id}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-bold text-white font-mono flex-1">{q.quoteNumber} — {q.supplierName}</p>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                    q.status === "SELECTED" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : q.status === "REJECTED" ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                    : "bg-slate-600/40 text-slate-300 border-slate-500/40"}`}>
                    {q.status}
                  </span>
                  <span className="text-xs font-black text-amber-300">GH₵ {Number(q.totalGhs || 0).toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {q.createdByName} · {new Date(q.createdAt).toLocaleDateString()}
                  {q.leadTimeDays ? ` · ${q.leadTimeDays}-day lead` : ""}{q.paymentTerms ? ` · ${q.paymentTerms}` : ""}
                  {q.supplierOrderId ? ` · PO raised` : ""}
                </p>
                <div className="mt-2 space-y-1">
                  {(q.lines || []).map((li: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-[11px] text-slate-300 bg-slate-900/60 rounded-lg px-3 py-1.5">
                      <span>{li.description} × {li.quantity}</span>
                      <span className="font-mono">GH₵ {Number(li.totalGhs || 0).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                {q.status === "QUOTED" && (
                  <button onClick={() => selectQuote(q)} disabled={busy} className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-quote-select-${q.id}`}>
                    Award &amp; raise PO
                  </button>
                )}
              </div>
            ))}
            {quotes.length === 0 && <p className="px-4 py-6 text-xs text-slate-500">No quotations yet. Add competing quotes against an approved requisition, then award the best one.</p>}
          </div>
        </div>
      )}

      {/* ══════════ INVOICES & PAYMENTS ══════════ */}
      {tab === "INVOICES" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-white">Supplier invoices &amp; payments</h4>
            <button onClick={() => setInvoiceFor({ id: "", invoiceNumber: "", invoiceDate: new Date().toISOString().slice(0, 10), amountGhs: "", notes: "" })} disabled={!bizId || !orders.filter((o: any) => o.status === "RECEIVED").length} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid="proc-new-invoice">
              <Plus className="w-3 h-3" /> Register invoice
            </button>
          </div>
          <div className="divide-y divide-slate-700/40" data-testid="proc-invoices">
            {invoices.map((inv: any) => {
              const outstanding = Math.max(0, Number(inv.amountGhs || 0) - Number(inv.amountPaidGhs || 0));
              return (
                <div key={inv.id} data-testid={`proc-invoice-${inv.id}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-bold text-white font-mono flex-1">{inv.invoiceNumber} — {inv.supplierName}</p>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                      inv.status === "MATCHED" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : inv.status === "VARIANCE" ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                      : inv.status === "PAID" ? "bg-green-500/15 text-green-300 border-green-500/30"
                      : inv.status === "CANCELLED" ? "bg-slate-600/40 text-slate-400 border-slate-500/40"
                      : "bg-amber-500/15 text-amber-300 border-amber-500/30"}`}>
                      {inv.status}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400">{inv.paymentMode === "ON_CREDIT" ? "on credit" : "on receipt"}</span>
                    <span className="text-xs font-black text-amber-300">GH₵ {Number(inv.amountGhs || 0).toFixed(2)}</span>
                  </div>
                  {(inv.matchResult || {}).varianceNote && (
                    <p className={`text-[10px] mt-1 ${inv.status === "VARIANCE" ? "text-rose-300" : "text-slate-400"}`}>{inv.matchResult.varianceNote}</p>
                  )}
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    Registered {new Date(inv.createdAt).toLocaleDateString()} by {inv.registeredByName}
                    {Number(inv.amountPaidGhs) > 0 ? ` · paid GH₵ ${Number(inv.amountPaidGhs).toFixed(2)} of GH₵ ${Number(inv.amountGhs).toFixed(2)}` : ""}
                  </p>
                  {(inv.payments || []).length > 0 && (
                    <div className="mt-2 space-y-1">
                      {(inv.payments || []).map((p: any) => (
                        <div key={p.id} className="flex items-center justify-between text-[11px] text-slate-300 bg-slate-900/60 rounded-lg px-3 py-1.5">
                          <span>{p.paymentNumber} · {p.paymentMethod} · {p.paidOn}</span>
                          <span className="font-mono">GH₵ {Number(p.amountGhs || 0).toFixed(2)}{p.transactionId ? " ✓ expensed" : ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!["PAID", "CANCELLED"].includes(inv.status) && outstanding > 0 && (
                    <button onClick={() => payInvoice(inv)} disabled={busy} className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-50" data-testid={`proc-invoice-pay-${inv.id}`}>
                      Record payment (GH₵ {outstanding.toFixed(2)} outstanding)
                    </button>
                  )}
                </div>
              );
            })}
            {invoices.length === 0 && <p className="px-4 py-6 text-xs text-slate-500">No invoices registered yet. Register supplier invoices against received POs — the 3-way match flags variances automatically.</p>}
          </div>
        </div>
      )}

      {/* ══════════ SUPPLIERS ══════════ */}
      {tab === "SUPPLIERS" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/60">
            <h4 className="text-xs font-extrabold text-white">Supplier performance</h4>
            <p className="text-[10px] text-slate-500 mt-0.5">Lead time = Raised → Received. Fill rate = received ÷ ordered. Invoice variance = average over/under billing.</p>
          </div>
          <div className="divide-y divide-slate-700/40" data-testid="proc-supplier-perf">
            {performance.map((s: any) => (
              <div key={s.supplierId} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white">{s.supplierName}</p>
                  <p className="text-[10px] text-slate-500">{s.orderCount} order{s.orderCount === 1 ? "" : "s"} · {s.receiptCount} receipt{s.receiptCount === 1 ? "" : "s"}{s.lastOrderAt ? ` · last ${new Date(s.lastOrderAt).toLocaleDateString()}` : ""}</p>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-slate-300">Lead <b className="text-white">{s.avgLeadTimeDays != null ? `${s.avgLeadTimeDays}d` : "—"}</b></span>
                  <span className="text-slate-300">Fill <b className={s.fillRatePct != null ? (s.fillRatePct >= 95 ? "text-emerald-300" : s.fillRatePct >= 80 ? "text-amber-300" : "text-rose-300") : "text-white"}>{s.fillRatePct != null ? `${s.fillRatePct}%` : "—"}</b></span>
                  <span className="text-slate-300">Var <b className={s.avgInvoiceVarianceGhs != null ? (Math.abs(s.avgInvoiceVarianceGhs) < 1 ? "text-emerald-300" : "text-rose-300") : "text-white"}>{s.avgInvoiceVarianceGhs != null ? `GH₵ ${s.avgInvoiceVarianceGhs.toFixed(2)}` : "—"}</b></span>
                </div>
              </div>
            ))}
            {performance.length === 0 && <p className="px-4 py-6 text-xs text-slate-500">No supplier history yet — performance appears once orders are received and invoices matched.</p>}
          </div>
        </div>
      )}

      {/* ── New-requisition modal ── */}
      {showReq && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
          data-testid="proc-req-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setShowReq(false); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-5 w-full max-w-xl space-y-4 max-h-[calc(100dvh-1rem)] overflow-y-auto my-auto">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">Draft purchase requisition</h4>
              <button onClick={() => setShowReq(false)} aria-label="Close" className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-2">
              {(reqDraft.lines || []).map((li: any, idx: number) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 bg-slate-800/60 rounded-lg p-2">
                  <select
                    value={li.inventoryId || ""}
                    onChange={(e) => {
                      const item = e.target.value ? invItem(Number(e.target.value)) : undefined;
                      const lines = [...reqDraft.lines];
                      lines[idx] = { ...li, inventoryId: e.target.value ? Number(e.target.value) : null, description: item?.name || li.description, unit: item?.unit || li.unit, estUnitCostGhs: item?.costPriceGhs ?? li.estUnitCostGhs };
                      setReqDraft({ ...reqDraft, lines });
                    }}
                    className="flex-1 min-w-40 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="">— pick a stock item —</option>
                    {inventory.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.sku || "no sku"} · {i.quantity} in stock)</option>)}
                  </select>
                  <input type="number" min={1} step="any" value={li.quantity} onChange={(e) => { const lines = [...reqDraft.lines]; lines[idx] = { ...li, quantity: Number(e.target.value) }; setReqDraft({ ...reqDraft, lines }); }} className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200" placeholder="Qty" />
                  <input type="number" min={0} step="any" value={li.estUnitCostGhs ?? ""} onChange={(e) => { const lines = [...reqDraft.lines]; lines[idx] = { ...li, estUnitCostGhs: e.target.value === "" ? null : Number(e.target.value) }; setReqDraft({ ...reqDraft, lines }); }} className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200" placeholder="GH₵/unit" />
                  <button onClick={() => setReqDraft({ ...reqDraft, lines: reqDraft.lines.filter((_: any, j: number) => j !== idx) })} className="text-rose-400 hover:text-rose-300 text-xs font-bold">✕</button>
                </div>
              ))}
              <button onClick={() => setReqDraft({ ...reqDraft, lines: [...reqDraft.lines, { inventoryId: null, description: "", quantity: 1, unit: null, estUnitCostGhs: null }] })} className="text-[11px] font-bold text-emerald-300 hover:text-emerald-200">+ Add line</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Needed by</label>
                <input type="date" value={reqDraft.needBy || ""} onChange={(e) => setReqDraft({ ...reqDraft, needBy: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Notes</label>
                <input value={reqDraft.notes || ""} onChange={(e) => setReqDraft({ ...reqDraft, notes: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setShowReq(false)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveRequisition} disabled={busy || !reqDraft.lines.length} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-req-save">Save draft</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add-quote modal ── */}
      {quoteFor !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
          data-testid="proc-quote-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setQuoteFor(null); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-5 w-full max-w-xl space-y-4 max-h-[calc(100dvh-1rem)] overflow-y-auto my-auto">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">{quoteFor ? `Quote for ${quoteFor.reqNumber}` : "Ad-hoc quotation"}</h4>
              <button onClick={() => setQuoteFor(null)} aria-label="Close" className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Supplier</label>
                <select value={quoteDraft.supplierId || ""} onChange={(e) => setQuoteDraft({ ...quoteDraft, supplierId: e.target.value, supplierName: e.target.value ? (suppliers.find((s: any) => String(s.id) === e.target.value)?.name || "") : quoteDraft.supplierName })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm">
                  <option value="">Ad-hoc / type name →</option>
                  {suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {!quoteDraft.supplierId && (
                  <input value={quoteDraft.supplierName || ""} onChange={(e) => setQuoteDraft({ ...quoteDraft, supplierName: e.target.value })} placeholder="Supplier name" className="w-full mt-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Lead (d)</label>
                  <input type="number" min={1} value={quoteDraft.leadTimeDays || ""} onChange={(e) => setQuoteDraft({ ...quoteDraft, leadTimeDays: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Terms</label>
                  <input value={quoteDraft.paymentTerms || ""} onChange={(e) => setQuoteDraft({ ...quoteDraft, paymentTerms: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Valid to</label>
                  <input type="date" value={quoteDraft.validUntil || ""} onChange={(e) => setQuoteDraft({ ...quoteDraft, validUntil: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {(quoteDraft.lines || []).map((li: any, idx: number) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 bg-slate-800/60 rounded-lg p-2">
                  <span className="flex-1 min-w-32 text-xs text-slate-300 truncate">{li.description || "Line"} × {li.quantity}</span>
                  <input type="number" min={0} step="any" value={li.unitCostGhs ?? ""} onChange={(e) => { const lines = [...quoteDraft.lines]; lines[idx] = { ...li, unitCostGhs: e.target.value === "" ? 0 : Number(e.target.value) }; setQuoteDraft({ ...quoteDraft, lines }); }} className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200" placeholder="GH₵/unit" />
                  <span className="text-[11px] font-mono text-amber-300 w-24 text-right">GH₵ {((Number(li.quantity) || 0) * (Number(li.unitCostGhs) || 0)).toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setQuoteFor(null)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveQuote} disabled={busy || !quoteDraft.lines.length || (!quoteDraft.supplierId && !quoteDraft.supplierName?.trim())} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-quote-save">Save quote</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Register-invoice modal ── */}
      {invoiceFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
          data-testid="proc-invoice-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setInvoiceFor(null); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-5 w-full max-w-lg space-y-4 max-h-[calc(100dvh-1rem)] overflow-y-auto my-auto">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">Register supplier invoice</h4>
              <button onClick={() => setInvoiceFor(null)} aria-label="Close" className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Purchase order (received)</label>
              <select value={invoiceFor.id || ""} onChange={(e) => setInvoiceFor({ ...invoiceFor, id: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="proc-inv-po">
                <option value="">— no PO (direct purchase) —</option>
                {orders.filter((o: any) => o.status === "RECEIVED").map((o: any) => (
                  <option key={o.id} value={o.id}>{o.purchaseOrderNumber} · {o.supplierName} · GH₵ {Number(o.totalGhs || 0).toFixed(2)}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Invoice number</label>
                <input value={invoiceFor.invoiceNumber || ""} onChange={(e) => setInvoiceFor({ ...invoiceFor, invoiceNumber: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Invoice date</label>
                <input type="date" value={invoiceFor.invoiceDate || ""} onChange={(e) => setInvoiceFor({ ...invoiceFor, invoiceDate: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Amount (GH₵)</label>
              <input type="number" min={0} step="any" value={invoiceFor.amountGhs || ""} onChange={(e) => setInvoiceFor({ ...invoiceFor, amountGhs: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="proc-inv-amount" />
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setInvoiceFor(null)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveInvoice} disabled={busy || !invoiceFor.invoiceNumber?.trim() || !Number(invoiceFor.amountGhs)} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-inv-save">Register &amp; match</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Raise-PO modal ── */}
      {showRaise && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
          data-testid="proc-raise-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setShowRaise(false); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-5 w-full max-w-xl space-y-4 max-h-[calc(100dvh-1rem)] overflow-y-auto my-auto">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">Raise purchase order</h4>
              <button onClick={() => setShowRaise(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Supplier</label>
              <select value={raiseDraft.supplierId || ""} onChange={(e) => setRaiseDraft({ ...raiseDraft, supplierId: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="proc-r-supplier">
                <option value="">Choose…</option>
                {suppliers.map((s: any) => (
                  <option key={s.id} value={s.id}>{s.name}{s.contactPhone ? ` · ${s.contactPhone}` : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Link customer pre-orders ({pendingOrders.length} waiting)</label>
              <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-700 divide-y divide-slate-700/60">
                {pendingOrders.map((o: any) => {
                  const hooked = (raiseDraft.trackingIds || []).includes(o.id);
                  return (
                    <label key={o.id} className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer ${hooked ? "bg-emerald-500/10" : ""}`}>
                      <input
                        type="checkbox"
                        checked={hooked}
                        onChange={(e) => {
                          const ids = e.target.checked
                            ? [...(raiseDraft.trackingIds || []), o.id]
                            : (raiseDraft.trackingIds || []).filter((x: number) => x !== o.id);
                          const picked = pendingOrders.filter((p: any) => ids.includes(p.id));
                          setRaiseDraft({ ...raiseDraft, trackingIds: ids, lines: buildLinesFromOrders(picked) });
                        }}
                        className="rounded"
                      />
                      <span className="font-mono text-slate-300">{o.trackingCode}</span>
                      <span className="text-slate-500 truncate">{o.customerName}</span>
                      <span className="ml-auto text-slate-400">GH₵ {Number(o.totalGhs || 0).toFixed(2)}</span>
                    </label>
                  );
                })}
                {pendingOrders.length === 0 && <p className="px-3 py-4 text-[11px] text-slate-500">No waiting pre-orders — supply lines from scratch below.</p>}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 mb-1">Lines ({raiseDraft.lines.length})</p>
              <div className="space-y-2">
                {raiseDraft.lines.map((li: any, idx: number) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 text-slate-300 truncate">{li.productName || `Product #${li.inventoryId}`}</span>
                    <input
                      type="number"
                      min={1}
                      value={li.quantity}
                      onChange={(e) => {
                        const lines = [...raiseDraft.lines];
                        lines[idx] = { ...li, quantity: Number(e.target.value) };
                        setRaiseDraft({ ...raiseDraft, lines });
                      }}
                      className="w-20 px-2 py-1 bg-slate-800 border border-slate-700 rounded text-white"
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="unit cost"
                      value={li.unitCostGhs}
                      onChange={(e) => {
                        const lines = [...raiseDraft.lines];
                        lines[idx] = { ...li, unitCostGhs: Number(e.target.value) };
                        setRaiseDraft({ ...raiseDraft, lines });
                      }}
                      className="w-28 px-2 py-1 bg-slate-800 border border-slate-700 rounded text-white"
                    />
                    <button onClick={() => setRaiseDraft({ ...raiseDraft, lines: raiseDraft.lines.filter((_: any, i: number) => i !== idx) })} className="text-slate-500 hover:text-rose-300"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setRaiseDraft({ ...raiseDraft, lines: [...raiseDraft.lines, { inventoryId: null, productName: "Product", quantity: 1, unitCostGhs: 0 }] })}
                className="mt-2 text-[11px] font-bold text-emerald-300 hover:text-emerald-200"
              >
                + Add manual line
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Expected arrival</label>
                <input type="date" value={raiseDraft.expectedAt || ""} onChange={(e) => setRaiseDraft({ ...raiseDraft, expectedAt: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Note to supplier</label>
                <input value={raiseDraft.note || ""} onChange={(e) => setRaiseDraft({ ...raiseDraft, note: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowRaise(false)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={raisePO} disabled={busy || !raiseDraft.supplierId || !raiseDraft.lines.length} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-r-save">Submit to supplier</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
