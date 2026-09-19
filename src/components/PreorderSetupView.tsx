"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  PackageCheck,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  X,
} from "lucide-react";

/**
 * Seller-facing pre-order catalogue editor:
 *  · Fulfilment methods (Air, Sea, Road, Local Delivery, Pickup …)—configurable per org.
 *  · Per-product fulfilment options with price, ETA window, deposit and terms.
 * All changes go through /api/fulfillment (server-scoped per unit + org).
 */

interface Method {
  id: number;
  key: string;
  label: string;
  icon: string;
  businessId: number | null;
  defaultLeadMinDays: number;
  defaultLeadMaxDays: number;
  requiresAddress?: boolean;
  active: boolean;
}

interface Option {
  id: number;
  inventoryId: number;
  inventoryName?: string | null;
  inventorySku?: string | null;
  methodId: number;
  priceGhs: number;
  leadMinDays: number;
  leadMaxDays: number;
  depositType: string;
  depositValue: number;
  termsKey: string;
  capacityPerPeriod: number | null;
  active: boolean;
  businessId?: number | null;
}

export default function PreorderSetupView({
  currentUser,
  businesses,
  scopedBusinesses,
}: {
  currentUser: any;
  businesses: any[];
  scopedBusinesses: any[];
}) {
  const [bizId, setBizId] = useState<string>(scopedBusinesses[0] ? String(scopedBusinesses[0].id) : "");
  const [methods, setMethods] = useState<Method[]>([]);
  const [options, setOptions] = useState<Option[]>([]);
  const [flags, setFlags] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  const [showMethod, setShowMethod] = useState(false);
  const [editMethod, setEditMethod] = useState<Method | null>(null);
  const [showOption, setShowOption] = useState(false);
  const [methodDraft, setMethodDraft] = useState<any>({});
  const [optionDraft, setOptionDraft] = useState<any>({});
  const [editOption, setEditOption] = useState<Option | null>(null);

  const loadCatalogue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(bizId ? `/api/fulfillment?businessId=${bizId}` : "/api/fulfillment", { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        setMethods(d.methods || []);
        setOptions(d.options || []);
        setFlags(d.preorderFlags || []);
        setSuppliers(d.suppliers || []);
        setInventory((d.inventory || []).filter((i: any) => (bizId ? Number(i.businessId) === Number(bizId) : true)));
        setError("");
      } else {
        setError(d?.error || "Could not load fulfilment catalogue.");
      }
    } catch {
      setError("Network error while loading catalogue.");
    } finally {
      setLoading(false);
    }
  }, [bizId]);

  useEffect(() => {
    loadCatalogue();
  }, [loadCatalogue]);

  const methodsForScope = useMemo(
    () => methods.filter((m) => m.active && (m.businessId == null || Number(m.businessId) === Number(bizId))),
    [methods, bizId],
  );

  const api = async (payload: any) => {
    const res = await fetch("/api/fulfillment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!d?.success) throw new Error(d?.error || "Action failed.");
    return d;
  };

  const seedDefaults = async () => {
    setBusy(true);
    setError("");
    try {
      await api({ action: "SEED_DEFAULTS", businessId: Number(bizId) });
      setFlash("Standard fulfilment methods added.");
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveMethod = async () => {
    if (!bizId) { setError("Choose a unit first."); return; }
    // Client-side validation so nothing silently degrades server-side.
    const key = String(methodDraft.key || "").trim();
    const label = String(methodDraft.label || "").trim();
    const mn = Number(methodDraft.leadMin ?? "");
    const mx = Number(methodDraft.leadMax ?? "");
    if (!editMethod && !key) { setError("Give the method a short key (e.g. BOAT)."); return; }
    if (!label) { setError("Give the method a customer-facing label."); return; }
    if (!(mn >= 0) || !(mx >= 0)) { setError("Set the default lead-time window in days (min & max)."); return; }
    if (mx < mn) { setError("Max lead days cannot be less than min lead days."); return; }
    setBusy(true);
    setError("");
    try {
      await api({
        action: editMethod ? "UPDATE_METHOD" : "ADD_METHOD",
        id: editMethod?.id,
        businessId: Number(bizId),
        key: editMethod ? editMethod.key : key,
        label,
        icon: methodDraft.icon || "truck",
        defaultLeadMinDays: mn,
        defaultLeadMaxDays: mx,
        requiresAddress: Boolean(methodDraft.requiresAddress),
        requiresPin: Boolean(methodDraft.requiresPin),
        businessScoped: editMethod ? editMethod.businessId != null : Boolean(methodDraft.businessScoped),
        active: editMethod ? methodDraft.active !== false : true,
      });
      setShowMethod(false);
      setEditMethod(null);
      setMethodDraft({});
      setFlash(editMethod ? "Fulfilment method updated." : "Fulfilment method added.");
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleMethod = async (m: Method) => {
    setBusy(true);
    setError("");
    try {
      await api({
        action: "UPDATE_METHOD",
        id: m.id,
        businessId: m.businessId != null ? Number(m.businessId) : Number(bizId),
        key: m.key,
        label: m.label,
        icon: m.icon,
        defaultLeadMinDays: m.defaultLeadMinDays,
        defaultLeadMaxDays: m.defaultLeadMaxDays,
        requiresAddress: Boolean(m.requiresAddress),
        requiresPin: Boolean((m as any).requiresPin),
        active: !m.active,
      });
      setFlash(m.active ? `Method "${m.label}" disabled — existing offers keep working at checkout but new pre-orders pick another method.` : `Method "${m.label}" re-enabled.`);
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveOption = async () => {
    setBusy(true);
    setError("");
    try {
      // Client-side validation — save nothing silently wrong.
      if (!optionDraft.inventoryId) throw new Error("Choose the product to offer.");
      if (!optionDraft.methodId) throw new Error("Choose a fulfilment/shipping method.");
      const price = Number(optionDraft.priceGhs);
      if (!(price > 0)) throw new Error("Enter the pre-order price per unit (greater than 0).");
      const lMn = Number(optionDraft.leadMinDays ?? "");
      const lMx = Number(optionDraft.leadMaxDays ?? "");
      if (!(lMn >= 0)) throw new Error("Set the minimum lead time in days.");
      if (!(lMx >= lMn)) throw new Error("Max lead days cannot be less than min lead days.");
      const depType = optionDraft.depositType || "NONE";
      const depVal = Number(optionDraft.depositValue) || 0;
      if (depType === "PERCENT" && !(depVal > 0 && depVal <= 100)) throw new Error("Deposit % must be between 1 and 100.");
      if (depType === "FIXED" && !(depVal > 0)) throw new Error("Enter the fixed deposit amount per unit.");
      if (depType === "FIXED" && depVal > price) throw new Error("A fixed deposit cannot exceed the price — use “pay full now”.");
      const payload: any = {
        action: editOption ? "UPDATE_OPTION" : "ADD_OPTION",
        businessId: Number(bizId),
        inventoryId: Number(optionDraft.inventoryId),
        methodId: Number(optionDraft.methodId),
        priceGhs: price,
        leadMinDays: lMn,
        leadMaxDays: lMx,
        depositType: depType,
        depositValue: depVal,
        termsKey: optionDraft.termsKey || "ON_FULFILLMENT",
        capacityPerPeriod: optionDraft.capacityPerPeriod != null && optionDraft.capacityPerPeriod !== "" ? Number(optionDraft.capacityPerPeriod) : null,
        supplierId: optionDraft.supplierId ?? null,
        requiresAddress: optionDraft.requiresAddress == null ? null : Boolean(optionDraft.requiresAddress),
      };
      if (editOption) {
        payload.id = editOption.id;
        payload.active = editOption.active;
      }
      await api(payload);
      setShowOption(false);
      setEditOption(null);
      setOptionDraft({});
      setFlash(editOption ? "Option updated." : "Pre-order option added.");
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleOption = async (o: Option) => {
    setBusy(true);
    try {
      await api({ action: "TOGGLE_OPTION", businessId: Number(o.businessId ?? Number(bizId)), id: o.id });
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const unitEnabled = useMemo(
    () => {
      if (!bizId) return true; // "All units" view — no single switch
      const f = flags.find((x: any) => Number(x.businessId) === Number(bizId));
      return f ? f.preOrderEnabled === true : false;
    },
    [flags, bizId],
  );

  const toggleUnitPreorders = async () => {
    if (!bizId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${bizId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preOrderEnabled: !unitEnabled }),
      });
      const d = await res.json();
      if (!d?.success) throw new Error(d?.error || "Could not update the unit.");
      setFlash(!unitEnabled
        ? "Pre-Orders enabled — this unit's active offers now appear on the customer storefront."
        : "Pre-Orders disabled — storefront stops showing this unit's offers (orders already placed still complete).");
      await loadCatalogue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const activeOptions = options.filter((o) => o.active);

  return (
    <div className="space-y-4" data-testid="po-root">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <div>
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <RouteIcon className="w-4 h-4 text-emerald-400" /> Pre-Order Catalogue
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Configure fulfilment methods and per-product pre-order offers — price, ETA window, deposit and balance terms.
            Customers see these on the storefront; nothing ships without them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={bizId} onChange={(e) => setBizId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200" data-testid="po-biz">
            <option value="">All units</option>
            {scopedBusinesses.map((b: any) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button onClick={loadCatalogue} className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300" title="Refresh" data-testid="po-refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          {bizId && (
            <button
              onClick={toggleUnitPreorders}
              disabled={busy}
              title={unitEnabled ? "Pre-Orders ON for this unit — click to disable" : "Pre-Orders OFF for this unit — click to enable"}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border transition disabled:opacity-50 ${unitEnabled ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "bg-slate-900/70 border-slate-600 text-slate-400 hover:text-slate-200"}`}
              data-testid="po-unit-enabled"
            >
              <span className={`w-7 h-4 rounded-full relative transition ${unitEnabled ? "bg-emerald-500" : "bg-slate-600"}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${unitEnabled ? "left-3.5" : "left-0.5"}`} />
              </span>
              {unitEnabled ? "Pre-Orders ON" : "Pre-Orders OFF"}
            </button>
          )}
          {methodsForScope.length === 0 && (
            <button onClick={seedDefaults} disabled={busy || !bizId} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50" data-testid="po-seed">
              Seed standard methods
            </button>
          )}
          <button onClick={() => { setMethodDraft({}); setEditMethod(null); setShowMethod(true); }} className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold flex items-center gap-1.5" data-testid="po-new-method">
            <Plus className="w-3.5 h-3.5" /> Method
          </button>
          <button onClick={() => { setOptionDraft({}); setEditOption(null); setShowOption(true); }} disabled={!bizId} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50" data-testid="po-new-option">
            <PackageCheck className="w-3.5 h-3.5" /> Offer
          </button>
        </div>
      </div>

      {flash && <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2" data-testid="po-flash">{flash}</p>}
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="po-error">{error}</p>}

      {bizId && !unitEnabled && (
        <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3" data-testid="po-off-banner">
          <span className="text-amber-300 text-sm leading-5">⚠</span>
          <div className="text-[11px] text-amber-200/90 leading-relaxed">
            <b>Pre-Orders are OFF for this unit.</b> You can prepare methods and offers here, but the storefront
            hides them and customers cannot place pre-orders until an Owner or Manage-Unit grantee flips the
            <b>&nbsp;Pre-Orders ON</b> switch above (also in <b>Manage Businesses → Online</b>).
          </div>
        </div>
      )}

      {/* ── Methods ── */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
          <h4 className="text-xs font-extrabold text-white">Fulfilment methods</h4>
          <span className="text-[10px] text-slate-500">{methodsForScope.length} usable · {methods.length - methodsForScope.length} disabled/scoped elsewhere</span>
        </div>
        <div className="divide-y divide-slate-700/40" data-testid="po-methods">
          {methods.map((m) => (
            <div key={m.id} className={`px-4 py-2.5 flex items-center justify-between gap-3 ${m.active ? "" : "opacity-50"}`} data-testid={`po-method-${m.id}`}>
              <div>
                <p className="text-xs font-bold text-slate-200 flex items-center gap-2">
                  <span className="w-6 h-6 rounded bg-slate-900 border border-slate-700 text-center leading-6 text-[10px]">{m.icon.slice(0, 2).toUpperCase()}</span>
                  {m.label}
                  {m.businessId == null && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">ORG</span>}
                  {!m.active && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">OFF</span>}
                </p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {m.defaultLeadMinDays}–{m.defaultLeadMaxDays} days lead
                  {m.requiresAddress ? " · needs delivery address" : ""}
                  {(m as any).requiresPin ? " · customer PIN" : ""}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => { setEditMethod(m); setMethodDraft({ ...m, leadMin: m.defaultLeadMinDays, leadMax: m.defaultLeadMaxDays }); setShowMethod(true); }}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold"
                  data-testid={`po-m-edit-${m.id}`}
                >
                  Edit
                </button>
                <button
                  onClick={() => toggleMethod(m)}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${m.active ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"}`}
                  data-testid={`po-m-toggle-${m.id}`}
                >
                  {m.active ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))}
          {methods.length === 0 && <p className="px-4 py-6 text-xs text-slate-500">No methods configured — seed the standard set or create one.</p>}
        </div>
      </div>

      {/* ── Options ── */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
          <h4 className="text-xs font-extrabold text-white">Product pre-order offers</h4>
          <span className="text-[10px] text-slate-500">{activeOptions.length} active</span>
        </div>
        <div className="divide-y divide-slate-700/40" data-testid="po-options">
          {options.map((o) => (
            <div key={o.id} className={`px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${o.active ? "" : "opacity-50"}`} data-testid={`po-option-${o.id}`}>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-200 truncate">{o.inventoryName || `Product #${o.inventoryId}`} {o.inventorySku ? <span className="text-slate-500 font-mono text-[10px]">({o.inventorySku})</span> : null}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {methods.find((m) => m.id === o.methodId)?.label || `Method #${o.methodId}`} · {o.leadMinDays}–{o.leadMaxDays}d lead
                  {(o as any).supplierId ? ` · supplier: ${suppliers.find((sp) => sp.id === (o as any).supplierId)?.name || "?"}` : ""}
                  {(o as any).requiresAddress === true ? " · address required" : (o as any).requiresAddress === false ? " · address not required" : ""}
                </p>
              </div>
              <div className="grid grid-cols-2 sm:flex sm:items-center gap-3 text-[10px] text-slate-300">
                <div><span className="text-slate-500 block uppercase font-bold">Price</span><span className="font-black text-white">GH₵ {Number(o.priceGhs).toFixed(2)}</span></div>
                <div><span className="text-slate-500 block uppercase font-bold">Deposit</span><span className="font-black text-amber-300">{o.depositType === "NONE" ? "None" : o.depositType === "PERCENT" ? `${o.depositValue}%` : `GH₵ ${Number(o.depositValue).toFixed(2)}`}</span></div>
                <div><span className="text-slate-500 block uppercase font-bold">Balance</span><span className="font-black text-cyan-300">{o.termsKey === "ON_ARRIVAL" ? "On arrival" : "On fulfillment"}</span></div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setEditOption(o); setOptionDraft({ ...o }); setShowOption(true); }} className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold" data-testid={`po-edit-${o.id}`}>Edit</button>
                <button onClick={() => toggleOption(o)} className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${o.active ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"}`} data-testid={`po-toggle-${o.id}`}>{o.active ? "Disable" : "Enable"}</button>
              </div>
            </div>
          ))}
          {options.length === 0 && <p className="px-4 py-6 text-xs text-slate-500">No pre-order offers yet — add one to start accepting pre-orders on this product.</p>}
        </div>
      </div>

      {/* ── New-method modal ── */}
      {showMethod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" data-testid="po-method-modal">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-md space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">{editMethod ? "Edit fulfilment method" : "New fulfilment method"}</h4>
              <button onClick={() => setShowMethod(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div><label className="block text-[11px] font-semibold text-slate-400 mb-1">Key (short word)</label>
                <input value={methodDraft.key || ""} disabled={!!editMethod} onChange={(e) => setMethodDraft({ ...methodDraft, key: e.target.value.toUpperCase() })} className={`w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm ${editMethod ? "opacity-40" : ""}`} placeholder="BOAT" data-testid="po-m-key" /></div>
              <div><label className="block text-[11px] font-semibold text-slate-400 mb-1">Customer-facing label</label>
                <input value={methodDraft.label || ""} onChange={(e) => setMethodDraft({ ...methodDraft, label: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" placeholder="Riverboat Courier" data-testid="po-m-label" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-[11px] font-semibold text-slate-400 mb-1">Min lead days</label>
                  <input type="number" value={methodDraft.leadMin ?? ""} onChange={(e) => setMethodDraft({ ...methodDraft, leadMin: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-m-leadmin" /></div>
                <div><label className="block text-[11px] font-semibold text-slate-400 mb-1">Max lead days</label>
                  <input type="number" value={methodDraft.leadMax ?? ""} onChange={(e) => setMethodDraft({ ...methodDraft, leadMax: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-m-leadmax" /></div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Icon</label>
                <select value={methodDraft.icon || "truck"} onChange={(e) => setMethodDraft({ ...methodDraft, icon: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-m-icon">
                  <option value="truck">Truck / Road</option>
                  <option value="plane">Plane / Air</option>
                  <option value="ship">Ship / Sea freight</option>
                  <option value="bike">Motorbike / courier</option>
                  <option value="store">Pickup point</option>
                  <option value="boat">Boat / River</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={Boolean(methodDraft.requiresAddress)} onChange={(e) => setMethodDraft({ ...methodDraft, requiresAddress: e.target.checked })} className="rounded" data-testid="po-m-address" />
                Requires a delivery address / pinned point from the customer
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={Boolean((methodDraft as any).requiresPin)} onChange={(e) => setMethodDraft({ ...methodDraft, requiresPin: e.target.checked })} className="rounded" data-testid="po-m-pin" />
                Customer must confirm a PIN/code at handover
              </label>
              {!editMethod && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={Boolean(methodDraft.businessScoped)} onChange={(e) => setMethodDraft({ ...methodDraft, businessScoped: e.target.checked })} className="rounded" />
                  Scope to {businesses.find((b: any) => String(b.id) === bizId)?.name || "this unit"} only
                </label>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowMethod(false); setEditMethod(null); setMethodDraft({}); }} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveMethod} disabled={busy} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50" data-testid="po-m-save">{editMethod ? "Save changes" : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New/edit-option modal ── */}
      {showOption && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" data-testid="po-option-modal">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">{editOption ? "Edit pre-order option" : "New pre-order option"}</h4>
              <button onClick={() => { setShowOption(false); setEditOption(null); }} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Product</label>
                <select value={optionDraft.inventoryId || ""} onChange={(e) => setOptionDraft({ ...optionDraft, inventoryId: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-inv">
                  <option value="">Choose a product…</option>
                  {inventory.map((i: any) => (
                    <option key={i.id} value={i.id}>{i.name} ({i.sku}) — stock {i.quantity}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Fulfilment method</label>
                <select value={optionDraft.methodId || ""} onChange={(e) => setOptionDraft({ ...optionDraft, methodId: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-method">
                  <option value="">Choose a method…</option>
                  {methodsForScope.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Price / unit (GH₵)</label>
                <input type="number" step="0.01" value={optionDraft.priceGhs ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, priceGhs: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-price" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Lead time, min days</label>
                <input type="number" value={optionDraft.leadMinDays ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, leadMinDays: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-leadmin" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Lead time, max days</label>
                <input type="number" value={optionDraft.leadMaxDays ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, leadMaxDays: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-leadmax" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Deposit</label>
                <select value={optionDraft.depositType || "NONE"} onChange={(e) => setOptionDraft({ ...optionDraft, depositType: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-deptype">
                  <option value="NONE">None — pay full now</option>
                  <option value="PERCENT">Percentage of total</option>
                  <option value="FIXED">Fixed amount per unit</option>
                </select>
              </div>
              {(optionDraft.depositType === "PERCENT" || optionDraft.depositType === "FIXED") && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">{optionDraft.depositType === "PERCENT" ? "Deposit %" : "Deposit GH₵/unit"}</label>
                  <input type="number" step="0.01" value={optionDraft.depositValue ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, depositValue: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-depval" />
                </div>
              )}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Preferred supplier (optional)</label>
                <select value={(optionDraft as any).supplierId ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, supplierId: e.target.value === "" ? null : Number(e.target.value) })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-supplier">
                  <option value="">Choose later in Procurement…</option>
                  {suppliers.map((sp) => (
                    <option key={sp.id} value={sp.id}>{sp.name}{sp.category ? ` · ${sp.category}` : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Delivery address</label>
                <select
                  value={(optionDraft as any).requiresAddress == null ? "INHERIT" : (optionDraft as any).requiresAddress ? "YES" : "NO"}
                  onChange={(e) => setOptionDraft({ ...optionDraft, requiresAddress: e.target.value === "INHERIT" ? null : e.target.value === "YES" })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  data-testid="po-o-addr"
                >
                  <option value="INHERIT">Use the method's rule</option>
                  <option value="YES">Always require an address</option>
                  <option value="NO">No address needed</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Balance timing</label>
                <select value={optionDraft.termsKey || "ON_FULFILLMENT"} onChange={(e) => setOptionDraft({ ...optionDraft, termsKey: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" data-testid="po-o-terms">
                  <option value="ON_FULFILLMENT">Balance when order is ready</option>
                  <option value="ON_ARRIVAL">Balance when stock arrives</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Capacity cap (optional)</label>
                <input type="number" value={optionDraft.capacityPerPeriod ?? ""} onChange={(e) => setOptionDraft({ ...optionDraft, capacityPerPeriod: e.target.value })} className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" placeholder="leave empty = unlimited" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowOption(false); setEditOption(null); }} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold">Cancel</button>
              <button onClick={saveOption} disabled={busy} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50" data-testid="po-o-save">{editOption ? "Save changes" : "Create option"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
