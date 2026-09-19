"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Factory,
  Plus,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";

/**
 * Procurement pipeline — raise purchase orders against suppliers for the
 * pre-order commitments flowing in from the storefront, advance them through
 * the chain (Submitted → Confirmed → Shipped → In Transit → Arrived) and post
 * the goods receipt that physically lands stock (only then do pre-order items
 * become reservable for customer fulfillment).
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
            <option value="">All units</option>
            {scopedBusinesses.map((b: any) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" data-testid="proc-refresh"><RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /></button>
          <button onClick={() => { setRaiseDraft({ lines: [], supplierId: "", trackingIds: [] }); setShowRaise(true); }} disabled={!bizId || !suppliers.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50" data-testid="proc-raise">
            <Plus className="w-3.5 h-3.5" /> Raise PO{pendingTotal ? ` (${pendingTotal} waiting)` : ""}
          </button>
        </div>
      </div>

      {flash && <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2" data-testid="proc-flash">{flash}</p>}
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="proc-error">{error}</p>}

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

      {/* ── Raise-PO modal ── */}
      {showRaise && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" data-testid="proc-raise-modal">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-xl space-y-4">
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
