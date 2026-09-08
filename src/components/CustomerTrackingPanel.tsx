"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Package,
  Plus,
  RefreshCw,
  Search,
  Truck,
  CheckCircle2,
  PackageCheck,
  MapPin,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  X,
  Radio,
  CircleStop,
  Clock3,
  User as UserIcon,
  Building2,
  Ban,
  Banknote,
  HandCoins,
  Globe,
  StickyNote,
  ClipboardList,
  Link2,
  Navigation,
  ShoppingBag,
  Landmark,
  Hash,
  Store,
} from "lucide-react";
import { formatMoney } from "@/lib/currency";
import AiSectionGuide from "./AiSectionGuide";
import {
  googleMapsEmbed,
  googleMapsLink,
  googleMapsRouteLink,
  parseGoogleMapsPin,
} from "@/lib/tracking";
import { validatePhone } from "@/lib/phone";

const STATUS_STYLES: Record<string, string> = {
  RECEIVED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  CONFIRMED: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40",
  PROCESSING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  READY: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  DISPATCHED: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  DELIVERED: "bg-green-600/20 text-green-300 border-green-500/40",
  COMPLETED: "bg-green-600/20 text-green-300 border-green-500/40",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};
const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Order Received",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  READY: "Ready for Pickup",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  PAYMENT: "Payment Confirmed",
};
const PAYMENT_STYLES: Record<string, string> = {
  PAID: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  UNPAID: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  PENDING_CONFIRMATION: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40",
  CREDIT: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
};
const PAYMENT_LABELS: Record<string, string> = {
  PAID: "PAID",
  UNPAID: "UNPAID",
  PENDING_CONFIRMATION: "MoMo pending",
};

interface Props {
  currentUser: any;
  businesses: any[];
  currentCurrency?: string;
  /** Workers open this embedded in their workspace — business is fixed. */
  lockedBusiness?: any | null;
}

type PanelView = "ORDERS" | "CONSOLE";

const PAYCHIP_FOR: Record<string, string> = {
  PAID: "PAID",
  UNPAID: "UNPAID",
  PENDING_CONFIRMATION: "MoMo pending",
  CREDIT: "CREDIT",
};

const fmtDate = (iso: any) => {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
};

export default function CustomerTrackingPanel({
  currentUser,
  businesses,
  currentCurrency = "GHS",
  lockedBusiness = null,
}: Props) {
  const [trackings, setTrackings] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<PanelView>("ORDERS");
  const [statusFilter, setStatusFilter] = useState("");
  const [bizFilter, setBizFilter] = useState<string>(lockedBusiness ? String(lockedBusiness.id) : "");
  const [branchFilter, setBranchFilter] = useState("");
  const [payFilter, setPayFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [note, setNote] = useState<Record<number, string>>({});
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [flash, setFlash] = useState("");
  const [copied, setCopied] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  const [liveFor, setLiveFor] = useState<{ id: number; since: number } | null>(null);
  const watchRef = useRef<number | null>(null);

  // Load ALL scoped orders once — the server enforces Business/Branch access;
  // every search & filter below runs client-side on this already-scoped set
  // (auto-refreshes every 15 s so the register stays live).
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/tracking", { credentials: "include" });
      const data = await res.json();
      if (data?.success) {
        setTrackings(data.trackings || []);
        setMeta(data.meta || null);
        setError("");
      } else {
        setError(data?.error || "Could not load orders.");
      }
    } catch {
      setError("Network error while loading orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(true);
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  const scopedBusinesses = useMemo(() => {
    if (lockedBusiness) return [lockedBusiness];
    const scope: number[] | "ALL" = meta?.scope === "ALL" ? "ALL" : Array.isArray(meta?.scope) ? meta.scope : [];
    if (scope === "ALL") return businesses;
    return businesses.filter((b) => (scope as number[]).includes(Number(b.id)));
  }, [businesses, meta?.scope, lockedBusiness]);

  const stopLive = useCallback(() => {
    if (watchRef.current != null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setLiveFor(null);
  }, []);

  useEffect(() => () => stopLive(), [stopLive]);

  const postAction = async (payload: any) => {
    const res = await fetch("/api/tracking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || "Action failed.");
    return data;
  };

  const setStatus = async (t: any, status: string) => {
    setBusyRow(t.id);
    setFlash("");
    try {
      await postAction({ action: "SET_STATUS", id: t.id, status, note: (note[t.id] || "").trim() || undefined });
      if (liveFor?.id === t.id && status !== "DISPATCHED") stopLive();
      setNote((n) => ({ ...n, [t.id]: "" }));
      setFlash(`${t.trackingCode} → ${STATUS_LABELS[status] || status}`);
      await load(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyRow(null);
    }
  };

  const [payMethod, setPayMethod] = useState<Record<number, string>>({});
  const setPaid = async (t: any) => {
    setBusyRow(t.id);
    setError("");
    try {
      await postAction({ action: "MARK_PAID", id: t.id, method: payMethod[t.id] || t.paymentMethod || "CASH" });
      setFlash(`${t.trackingCode} marked PAID — revenue booked`);
      await load(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyRow(null);
    }
  };

  const startLive = async (t: any) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This device does not support location sharing.");
      return;
    }
    setError("");
    setLiveFor({ id: t.id, since: Date.now() });
    const push = (pos: GeolocationPosition) => {
      postAction({
        action: "LOCATION",
        id: t.id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        driverName: currentUser?.name,
      }).catch(() => {});
    };
    watchRef.current = navigator.geolocation.watchPosition(push, () => setLiveFor(null), {
      enableHighAccuracy: true,
      maximumAge: 5000,
    });
  };

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(""), 1600);
    } catch {}
  };

  // ── Filtering (client-side, on the server-scoped set) ────────────────
  const baseFiltered = useMemo(() => {
    const ql = search.trim().toLowerCase();
    return trackings.filter((t) => {
      if (bizFilter && String(t.businessId) !== String(bizFilter)) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (ql) {
        const items = Array.isArray(t.items) ? t.items : [];
        const hit =
          String(t.trackingCode || "").toLowerCase().includes(ql) ||
          String(t.customerName || "").toLowerCase().includes(ql) ||
          String(t.customerPhone || "").toLowerCase().includes(ql) ||
          items.some((li: any) => String(li?.description || "").toLowerCase().includes(ql));
        if (!hit) return false;
      }
      return true;
    });
  }, [trackings, bizFilter, statusFilter, search]);

  const branchOptions = useMemo(() => {
    const set = new Set<string>();
    trackings
      .filter((t) => !bizFilter || String(t.businessId) === String(bizFilter))
      .forEach((t) => {
        const b = t.branchName || t.branchCode;
        if (b) set.add(String(b));
      });
    return [...set.values()];
  }, [trackings, bizFilter]);

  // The Orders register: all filters incl. branch, payment, date range.
  const orderRows = useMemo(
    () =>
      baseFiltered.filter((t) => {
        if (branchFilter && String(t.branchName || t.branchCode || "") !== branchFilter) return false;
        if (payFilter && String(t.paymentStatus || "UNPAID") !== payFilter) return false;
        if (dateFrom || dateTo) {
          const d = String(t.createdAt || "").slice(0, 10);
          if (dateFrom && d < dateFrom) return false;
          if (dateTo && d > dateTo) return false;
        }
        return true;
      }),
    [baseFiltered, branchFilter, payFilter, dateFrom, dateTo],
  );

  const ordersActiveValue = useMemo(
    () =>
      orderRows
        .filter((t) => !["DELIVERED", "COMPLETED", "CANCELLED"].includes(t.status))
        .reduce((acc, t) => acc + (Number(t.totalGhs) || 0), 0),
    [orderRows],
  );

  const counts = meta?.counts || { total: 0, active: 0, dispatched: 0, ready: 0, doneThisWeek: 0 };
  const fmt = (n: number | null | undefined) => formatMoney(Number(n || 0), (currentCurrency as any) || "GHS");

  const chipsFor = (t: any) => (
    <>
      {t.orderSource === "ONLINE" && (
        <span className="flex items-center gap-0.5 text-[9px] font-black px-1.5 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 shrink-0" data-testid={`ct-online-${t.id}`}>
          <Globe className="w-2.5 h-2.5" /> ONLINE
        </span>
      )}
      {t.orderSource !== "SALE" && (
        <span className={`text-[9px] font-black px-1.5 py-1 rounded border shrink-0 ${PAYMENT_STYLES[t.paymentStatus] || PAYMENT_STYLES.UNPAID}`} data-testid={`ct-paychip-${t.id}`}>
          {PAYCHIP_FOR[t.paymentStatus] || "UNPAID"}
        </span>
      )}
      {/* Credit sale chip — till sales normally carry no payment chip, but a
          credit order is still paying off, so surface its live position. */}
      {t.credit && (
        <span className="flex items-center gap-0.5 text-[9px] font-black px-1.5 py-1 rounded border shrink-0 bg-cyan-500/15 text-cyan-300 border-cyan-500/40" data-testid={`ct-credit-${t.id}`}>
          <HandCoins className="w-2.5 h-2.5" /> {t.credit.status === "PAID" ? "CREDIT PAID" : `CREDIT · GH₵${Number(t.credit.balanceGhs || 0).toFixed(2)} DUE`}
        </span>
      )}
    </>
  );

  // ── Shared order detail (used by both the Orders register row expansion
  //    and the Live-tracking console cards) ─────────────────────────────
  const renderDetail = (t: any) => {
    const history = Array.isArray(t.statusHistory) ? [...t.statusHistory].reverse() : [];
    const isTerminal = ["DELIVERED", "COMPLETED", "CANCELLED"].includes(t.status);
    return (
      <div className="space-y-3" data-testid={`ct-detail-${t.id}`}>
        {/* Linked systems — Customer → Order → Business → Branch → Sales → Inventory → Finance → Delivery → Tracking */}
        <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3" data-testid={`ct-links-${t.id}`}>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5" /> Linked systems
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-bold">
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300" data-testid={`ct-link-track-${t.id}`}>
              <Truck className="w-3 h-3" /> Tracking {t.trackingCode}
            </span>
            {t.linkedDocument ? (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" data-testid={`ct-link-sale-${t.id}`}>
                <ShoppingBag className="w-3 h-3" /> Sales {t.linkedDocument.number}
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-400" data-testid={`ct-link-sale-${t.id}`}>
                <ShoppingBag className="w-3 h-3" /> Sales: {t.orderSource === "ONLINE" ? "storefront order (no till doc)" : "no till doc"}
              </span>
            )}
            {t.linkedTransaction ? (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" data-testid={`ct-link-finance-${t.id}`}>
                <Landmark className="w-3 h-3" /> Finance {t.linkedTransaction.number} · {t.linkedTransaction.type || "INCOME"}
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-400" data-testid={`ct-link-finance-${t.id}`}>
                <Landmark className="w-3 h-3" /> Finance: {t.paymentStatus === "PAID" ? "—" : "books on payment"}
              </span>
            )}
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300" data-testid={`ct-link-inventory-${t.id}`}>
              <Package className="w-3 h-3" /> Inventory: {t.stockCommitted ? "stock reserved" : t.orderSource === "ONLINE" ? "reserves at Confirm" : "product lines"}
            </span>
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300" data-testid={`ct-link-delivery-${t.id}`}>
              {t.fulfillmentType === "DELIVERY" ? <Truck className="w-3 h-3" /> : <Store className="w-3 h-3" />}
              {t.fulfillmentType === "DELIVERY"
                ? `Delivery${t.deliveryLat != null ? " · Google-Maps pin set" : " · address only"}`
                : t.pickupLocationName
                ? `Pickup · ${t.pickupLocationName}`
                : "Pickup at branch"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Items */}
          <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5" /> Products ({(t.items || []).length})
            </div>
            {(t.items || []).length === 0 ? (
              <p className="text-[11px] text-slate-500">No items registered.</p>
            ) : (
              <ul className="space-y-1">
                {(t.items || []).map((li: any, i: number) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-300 truncate">{li.quantity}× {li.description}</span>
                    {li.total != null && <span className="text-slate-400 font-semibold shrink-0">{fmt(li.total)}</span>}
                  </li>
                ))}
              </ul>
            )}
            {Number(t.discountGhs) > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-0.5 text-[11px]">
                <div className="flex items-center justify-between text-slate-500">
                  <span>Subtotal</span>
                  <span>{fmt((Number(t.totalGhs) || 0) + (Number(t.discountGhs) || 0))}</span>
                </div>
                <div className="flex items-center justify-between text-amber-300" data-testid={`ct-discount-${t.id}`}>
                  <span>Discount{Number(t.discountPercent) > 0 ? ` (${Number(t.discountPercent)}%)` : ""}</span>
                  <span>− {fmt(t.discountGhs)}</span>
                </div>
              </div>
            )}
            <div className="mt-2 pt-2 border-t border-slate-700/60 flex items-center justify-between text-[11px] font-bold">
              <span className="text-slate-400">Total</span>
              <span className="text-emerald-300">{fmt(t.totalGhs)}</span>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 space-y-0.5">
              <div className="flex items-center gap-1.5"><Building2 className="w-3 h-3" />{t.businessName}{t.branchName ? ` — ${t.branchName}` : ""}</div>
              <div className="flex items-center gap-1.5"><UserIcon className="w-3 h-3" />{t.customerName}{t.customerPhone ? ` · ${t.customerPhone}` : ""}</div>
              <div className="flex items-center gap-1.5">
                {t.fulfillmentType === "DELIVERY" ? <Truck className="w-3 h-3" /> : <PackageCheck className="w-3 h-3" />}
                {t.fulfillmentType === "DELIVERY" ? "Delivery" : "Pickup"}{t.destinationAddress ? ` → ${t.destinationAddress}` : ""}
              </div>
              {t.pickupLocationName && (
                <div className="flex items-center gap-1.5 text-emerald-300/90" data-testid={`ct-pickpoint-${t.id}`}>
                  <PackageCheck className="w-3 h-3" />Pickup point: {t.pickupLocationName}{t.pickupLocationAddress ? ` — ${t.pickupLocationAddress}` : ""}
                </div>
              )}
              <div className="flex items-center gap-1.5"><Clock3 className="w-3 h-3" />Placed {new Date(t.createdAt).toLocaleString()}</div>
              <div className="flex items-center gap-1.5 font-mono text-slate-600"><Hash className="w-3 h-3" />{t.orderRef || `#${t.id}`}</div>
              {t.customerNote && (
                <div className="flex items-start gap-1.5" data-testid={`ct-custnote-${t.id}`}>
                  <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
                  <span className="text-amber-300/90">“{t.customerNote}”</span>
                </div>
              )}
              {t.orderSource !== "SALE" && (
                <div className="flex items-center gap-1.5">
                  <Banknote className="w-3 h-3" />
                  {t.paymentStatus === "PAID"
                    ? `Paid ${t.paymentMethod === "MTN_MOMO" ? "(MTN MoMo)" : t.paymentMethod === "CASH" ? "(Cash)" : ""}`
                    : t.paymentStatus === "PENDING_CONFIRMATION"
                    ? "Payment pending confirmation (MoMo)"
                    : "Payment not yet received"}
                </div>
              )}
              {/* Credit installment position — paid vs outstanding on the order */}
              {t.credit && (
                <div className="flex items-center gap-1.5 text-cyan-300" data-testid={`ct-credit-line-${t.id}`}>
                  <HandCoins className="w-3 h-3" />
                  {t.credit.status === "PAID"
                    ? `Credit fully paid (${t.credit.creditCode})`
                    : `Credit: paid GH₵${Number(t.credit.amountPaidGhs || 0).toFixed(2)} of GH₵${Number(t.credit.totalGhs || 0).toFixed(2)} · outstanding GH₵${Number(t.credit.balanceGhs || 0).toFixed(2)}${t.credit.dueDate ? ` · due ${t.credit.dueDate}` : ""}`}
                </div>
              )}
            </div>
            <div className="mt-2.5 flex items-center gap-1.5">
              <a
                href={t.trackUrl}
                target="_blank"
                className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[10px] font-bold hover:bg-cyan-500/25"
                data-testid={`ct-public-${t.id}`}
              >
                <ExternalLink className="w-3 h-3" /> Customer page
              </a>
              <button
                onClick={() => copy(`${window.location.origin}${t.trackUrl}`, `link-${t.id}`)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-700/60 border border-slate-600/60 text-slate-300 text-[10px] font-bold hover:bg-slate-700"
                data-testid={`ct-copy-${t.id}`}
              >
                <Copy className="w-3 h-3" /> {copied === `link-${t.id}` ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Status history</div>
            <ol className="space-y-2" data-testid={`ct-history-${t.id}`}>
              {history.map((h: any, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[11px]">
                  <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${i === 0 ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <span className="min-w-0">
                    <span className="font-bold text-slate-200">{STATUS_LABELS[h.status] || h.status}</span>
                    <span className="block text-slate-500">{h.at ? new Date(h.at).toLocaleString() : ""}{h.by ? ` · ${h.by}` : ""}</span>
                    {h.note && <span className="block text-slate-400 italic">“{h.note}”</span>}
                  </span>
                </li>
              ))}
            </ol>
            {t.status === "DISPATCHED" && t.driverLat != null && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cyan-300" data-testid={`ct-liveloc-${t.id}`}>
                <MapPin className="w-3 h-3" />
                Live: {t.driverLat.toFixed(5)}, {t.driverLng.toFixed(5)}
                {t.driverLocationAt ? ` · ${Math.max(1, Math.round((Date.now() - new Date(t.driverLocationAt).getTime()) / 1000))}s ago` : ""}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3" data-testid={`ct-actions-${t.id}`}>
            {/* Payment confirmation (not needed for till sales) */}
            {t.orderSource !== "SALE" && t.status !== "CANCELLED" && (
              <div className="mb-2.5 pb-2.5 border-b border-slate-700/60">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
                  <Banknote className="w-3 h-3" /> Payment
                </div>
                {t.paymentStatus === "PAID" ? (
                  <p className="text-[11px] font-bold text-emerald-300" data-testid={`ct-paid-line-${t.id}`}>
                    Paid {(t.paymentMethod === "MTN_MOMO" ? "via MTN MoMo" : "in Cash")}
                    {t.paymentMarkedBy ? ` · confirmed by ${t.paymentMarkedBy}` : ""}
                  </p>
                ) : (
                  <div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 mb-1.5">
                      <span>
                        {t.paymentStatus === "PENDING_CONFIRMATION"
                          ? "Customer says they paid via MoMo — verify & confirm"
                          : t.paymentChoice === "ON_DELIVERY" || t.orderSource === "MANUAL"
                          ? "Collect payment on pickup / delivery"
                          : "Awaiting payment"}
                      </span>
                      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${PAYMENT_STYLES[t.paymentStatus] || PAYMENT_STYLES.UNPAID}`}>
                        {PAYCHIP_FOR[t.paymentStatus]}
                      </span>
                    </div>
                    {t.businessHelpPhone && (
                      <p className="text-[10px] text-emerald-300/90 mb-1.5" data-testid={`ct-bizphone-${t.id}`}>
                        Customer can call <span className="font-black">{t.businessHelpPhone}</span> for payment assistance / delivery support
                      </p>
                    )}
                    {t.paymentRef && (
                      <p className="text-[10px] text-yellow-300/90 mb-1.5" data-testid={`ct-payref-${t.id}`}>MoMo ref: {t.paymentRef}</p>
                    )}
                    <div className="flex items-center gap-1.5">
                      <select
                        value={payMethod[t.id] || t.paymentMethod || "CASH"}
                        onChange={(e) => setPayMethod((s) => ({ ...s, [t.id]: e.target.value }))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-200"
                        data-testid={`ct-paymethod-${t.id}`}
                      >
                        <option value="CASH">Cash</option>
                        <option value="MTN_MOMO">MTN MoMo</option>
                      </select>
                      <button
                        onClick={() => setPaid(t)}
                        disabled={busyRow === t.id}
                        className="flex-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-40"
                        data-testid={`ct-markpaid-${t.id}`}
                      >
                        Confirm payment received
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Update status</div>
            {isTerminal ? (
              <p className="text-[11px] text-slate-500">Order is closed{ t.status === "CANCELLED" ? " (cancelled)" : ""}. No further updates.</p>
            ) : (
              <>
                <input
                  value={note[t.id] || ""}
                  onChange={(e) => setNote((n) => ({ ...n, [t.id]: e.target.value }))}
                  placeholder="Optional note for the customer timeline…"
                  className="w-full mb-2 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-[11px] text-slate-200 outline-none focus:border-cyan-500/60"
                  data-testid={`ct-note-${t.id}`}
                />
                <div className="flex flex-wrap gap-1.5">
                  {(t.allowedNext || []).map((n: any) => (
                    <button
                      key={n.status}
                      disabled={busyRow === t.id}
                      onClick={() => setStatus(t, n.status)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition disabled:opacity-40 ${
                        n.status === "CANCELLED"
                          ? "bg-rose-500/10 border-rose-500/40 text-rose-300 hover:bg-rose-500/20"
                          : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20"
                      }`}
                      data-testid={`ct-adv-${t.id}-${n.status}`}
                    >
                      {n.status === "CANCELLED" ? <Ban className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                      {n.label}
                    </button>
                  ))}
                </div>
                {t.status === "DISPATCHED" && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-700/60">
                    {liveFor?.id === t.id ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-cyan-300" data-testid={`ct-live-state-${t.id}`}>
                          <Radio className="w-3.5 h-3.5 animate-pulse" /> Sharing live location…
                        </span>
                        <button
                          onClick={stopLive}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[10px] font-bold"
                          data-testid={`ct-live-stop-${t.id}`}
                        >
                          <CircleStop className="w-3 h-3" /> Stop
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startLive(t)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold hover:bg-cyan-500/25"
                        data-testid={`ct-live-start-${t.id}`}
                      >
                        <MapPin className="w-3.5 h-3.5" /> Share my live location with the customer
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Delivery location — customer's Google-Maps pin (staff & couriers only) */}
        {t.fulfillmentType === "DELIVERY" && (
          <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-3" data-testid={`ct-delivery-${t.id}`}>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-cyan-300" /> Delivery location (Google Maps)
              </div>
              <span className="text-[9px] text-slate-500">Visible only to your team & the courier</span>
            </div>
            {t.deliveryLat != null && t.deliveryLng != null ? (
              <>
                <div className="rounded-xl overflow-hidden border border-slate-700">
                  <iframe
                    key={`${t.deliveryLat},${t.deliveryLng}`}
                    title="Customer delivery pin — Google Maps"
                    src={googleMapsEmbed(t.deliveryLat, t.deliveryLng, 17)}
                    className="w-full h-[240px] bg-slate-800"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    data-testid={`ct-delivmap-${t.id}`}
                  />
                </div>
                <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[10px]">
                  <span className="font-mono text-cyan-300/90" data-testid={`ct-delivcoords-${t.id}`}>
                    {t.deliveryLat.toFixed(6)}, {t.deliveryLng.toFixed(6)}
                    {t.deliveryAccuracyM ? ` · GPS ±${Math.round(t.deliveryAccuracyM)} m` : ""}
                  </span>
                  {t.destinationAddress && <span className="text-slate-500">· {t.destinationAddress}</span>}
                  <span className="flex-1" />
                  <a
                    href={t.deliveryMapLink || googleMapsLink(t.deliveryLat, t.deliveryLng)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-bold hover:bg-cyan-500/25"
                    data-testid={`ct-delivopen-${t.id}`}
                  >
                    <Navigation className="w-3 h-3" /> Open in Google Maps
                  </a>
                  <button
                    onClick={() => copy(`${t.deliveryLat.toFixed(6)}, ${t.deliveryLng.toFixed(6)}`, `coords-${t.id}`)}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-slate-700/60 border border-slate-600/60 text-slate-300 font-bold hover:bg-slate-700"
                    data-testid={`ct-delivcopy-${t.id}`}
                  >
                    <Copy className="w-3 h-3" /> {copied === `coords-${t.id}` ? "Copied!" : "Copy coordinates"}
                  </button>
                </div>
                {t.status === "DISPATCHED" && t.driverLat != null && t.driverLng != null && (
                  <a
                    href={googleMapsRouteLink(t.driverLat, t.driverLng, t.deliveryLat, t.deliveryLng)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/25"
                    data-testid={`ct-delivroute-${t.id}`}
                  >
                    <Truck className="w-3.5 h-3.5" /> Courier route: live position → customer pin (Google Maps)
                  </a>
                )}
              </>
            ) : (
              <p className="text-[11px] text-slate-400" data-testid={`ct-delivnopin-${t.id}`}>
                No Google-Maps pin on this delivery — destination: <span className="text-slate-300">{t.destinationAddress || "not recorded"}</span>.
                Confirm the exact location with the customer on {t.customerPhone || "their number"}.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="ct-root">
      {/* Header */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-cyan-500/15 border border-cyan-500/30 shrink-0">
              <Truck className="w-5 h-5 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-extrabold text-white">Customer Order & Tracking</h2>
              <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
                Every customer order linked to its unique GM-* code · customers order on{" "}
                <a href="/order" target="_blank" className="text-cyan-300 underline decoration-cyan-500/50 hover:text-cyan-200" data-testid="ct-storefront-home">
                  /order
                </a>{" "}
                and follow it on{" "}
                <a href="/track" target="_blank" className="text-cyan-300 underline decoration-cyan-500/50 hover:text-cyan-200" data-testid="ct-public-home">
                  /track
                </a>{" "}
                — no login needed.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AiSectionGuide
              moduleKey="TRACKING"
              section="TRACKING"
              businessInfo={lockedBusiness ? { name: lockedBusiness.name, code: lockedBusiness.code } : null}
              variant="header"
            />
            <button
              onClick={() => load()}
              className="p-2 rounded-lg hover:bg-slate-700/70 text-slate-300"
              title="Refresh"
              data-testid="ct-refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setShowNew(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow"
              data-testid="ct-new-btn"
            >
              <Plus className="w-4 h-4" /> New Tracking
            </button>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Orders", value: counts.active, cls: "text-amber-300", testid: "ct-kpi-active" },
          { label: "Out for Delivery", value: counts.dispatched, cls: "text-cyan-300", testid: "ct-kpi-dispatched" },
          { label: "Ready for Pickup", value: counts.ready, cls: "text-emerald-300", testid: "ct-kpi-ready" },
          { label: "Completed (7d)", value: counts.doneThisWeek, cls: "text-green-300", testid: "ct-kpi-done" },
        ].map((k) => (
          <div key={k.testid} className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-3.5" data-testid={k.testid}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{k.label}</div>
            <div className={`text-xl font-black mt-1 ${k.cls}`}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* View toggle — the dedicated Orders register vs the Live-tracking console */}
      <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-700 rounded-xl p-1 w-fit" data-testid="ct-viewtoggle">
        <button
          onClick={() => setView("ORDERS")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${
            view === "ORDERS" ? "bg-emerald-600 text-white shadow" : "text-slate-300 hover:text-white"
          }`}
          data-testid="ct-view-orders"
        >
          <ClipboardList className="w-3.5 h-3.5" /> Orders
        </button>
        <button
          onClick={() => setView("CONSOLE")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${
            view === "CONSOLE" ? "bg-emerald-600 text-white shadow" : "text-slate-300 hover:text-white"
          }`}
          data-testid="ct-view-console"
        >
          <Truck className="w-3.5 h-3.5" /> Live tracking
        </button>
      </div>

      {/* Shared filters: status · business · search (code/customer/product) */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
          data-testid="ct-filter-status"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        {!lockedBusiness && scopedBusinesses.length > 1 && (
          <select
            value={bizFilter}
            onChange={(e) => { setBizFilter(e.target.value); setBranchFilter(""); }}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
            data-testid="ct-filter-biz"
          >
            <option value="">All my businesses</option>
            {scopedBusinesses.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, customer or product…"
            className="w-full pl-8 pr-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 outline-none focus:border-cyan-500/60"
            data-testid="ct-search"
          />
        </div>
      </div>

      {/* Orders-only filters: branch · payment · date range */}
      {view === "ORDERS" && (
        <div className="flex flex-wrap items-center gap-2" data-testid="ct-orders-filters">
          {branchOptions.length > 1 && (
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
              data-testid="ct-orders-branch"
            >
              <option value="">All branches</option>
              {branchOptions.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          )}
          <select
            value={payFilter}
            onChange={(e) => setPayFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
            data-testid="ct-orders-payment"
          >
            <option value="">All payments</option>
            <option value="PAID">Paid</option>
            <option value="UNPAID">Unpaid</option>
            <option value="PENDING_CONFIRMATION">MoMo pending</option>
          </select>
          <label className="flex items-center gap-1.5 text-[10px] text-slate-400 font-bold">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
              data-testid="ct-orders-from"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-slate-400 font-bold">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
              data-testid="ct-orders-to"
            />
          </label>
          {(branchFilter || payFilter || dateFrom || dateTo || search || statusFilter || bizFilter) && (
            <button
              onClick={() => { setBranchFilter(""); setPayFilter(""); setDateFrom(""); setDateTo(""); setSearch(""); setStatusFilter(""); if (!lockedBusiness) setBizFilter(""); }}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-[10px] font-bold hover:text-white"
              data-testid="ct-orders-reset"
            >
              <X className="w-3 h-3" /> Reset filters
            </button>
          )}
          <span className="ml-auto text-[10px] text-slate-500 font-semibold" data-testid="ct-orders-summary">
            {orderRows.length} order{orderRows.length === 1 ? "" : "s"} · active value {fmt(ordersActiveValue)}
          </span>
        </div>
      )}

      {flash && (
        <div className="px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold" data-testid="ct-flash">
          {flash}
        </div>
      )}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between" data-testid="ct-error">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-rose-300/70 hover:text-rose-200"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── ORDERS register ── */}
      {view === "ORDERS" && (
        loading ? (
          <div className="text-center text-slate-400 text-xs py-10">Loading orders…</div>
        ) : orderRows.length === 0 ? (
          <div className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-8 text-center" data-testid="ct-orders-empty">
            <ClipboardList className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">No orders match</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Online storefront orders, till sales and staff bookings all land here, each linked to its GM-* tracking code.
            </p>
          </div>
        ) : (
          <>
            <div className="hidden lg:block bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl" data-testid="ct-orders-table">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-700">
                    <th className="px-3 py-2">Order ID</th>
                    <th className="px-2 py-2">Tracking Code</th>
                    <th className="px-2 py-2">Customer</th>
                    <th className="px-2 py-2">Business</th>
                    <th className="px-2 py-2">Branch</th>
                    <th className="px-2 py-2">Products</th>
                    <th className="px-2 py-2 text-right">Amount</th>
                    <th className="px-2 py-2">Payment</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-3 py-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {orderRows.map((t) => {
                    const open = !!expanded[t.id];
                    const items = Array.isArray(t.items) ? t.items : [];
                    return (
                      <React.Fragment key={t.id}>
                        <tr
                          onClick={() => setExpanded((s) => ({ ...s, [t.id]: !open }))}
                          className="cursor-pointer hover:bg-slate-700/30 border-b border-slate-700/60 align-middle"
                          data-testid={`ct-expand-${t.id}`}
                        >
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-400 whitespace-nowrap" data-testid={`ct-orders-oid-${t.id}`}>
                            {t.orderRef || `#${t.id}`}
                          </td>
                          <td className="px-2 py-2">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="font-mono text-[10px] font-black text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded px-1.5 py-1" data-testid={`ct-code-${t.id}`}>
                                {t.trackingCode}
                              </span>
                              {chipsFor(t)}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            <span className="block text-[11px] font-bold text-white max-w-[140px] truncate">{t.customerName}</span>
                            {t.customerPhone && <span className="block text-[9px] text-slate-500 max-w-[140px] truncate">{t.customerPhone}</span>}
                          </td>
                          <td className="px-2 py-2 text-[11px] text-slate-300 max-w-[130px] truncate" title={t.businessName}>{t.businessName}</td>
                          <td className="px-2 py-2 text-[10px] text-slate-400 max-w-[110px] truncate" title={t.branchName || t.branchCode || ""}>
                            {t.branchName || t.branchCode || "—"}
                          </td>
                          <td className="px-2 py-2 text-[10px] text-slate-400 max-w-[150px]">
                            <span className="block truncate" title={items.map((li: any) => `${li.quantity}× ${li.description}`).join(", ")}>
                              {items.length} item{items.length === 1 ? "" : "s"}{items[0] ? ` · ${items[0].description}` : ""}
                            </span>
                            {t.deliveryLat != null && (
                              <span className="inline-flex items-center gap-0.5 text-[9px] text-cyan-300" title="Google-Maps delivery pin set">
                                <MapPin className="w-2.5 h-2.5" /> pinned
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-[11px] font-black text-emerald-300 whitespace-nowrap" data-testid={`ct-orders-amount-${t.id}`}>
                            {fmt(t.totalGhs)}
                          </td>
                          <td className="px-2 py-2">
                            <span className={`text-[9px] font-black px-1.5 py-1 rounded border ${PAYMENT_STYLES[t.paymentStatus] || PAYMENT_STYLES.UNPAID}`} data-testid={`ct-orders-pay-${t.id}`}>
                              {t.orderSource === "SALE" ? "PAID" : PAYCHIP_FOR[t.paymentStatus] || "UNPAID"}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            <span className={`text-[10px] font-black px-2 py-1 rounded-full border whitespace-nowrap ${STATUS_STYLES[t.status] || STATUS_STYLES.RECEIVED}`} data-testid={`ct-status-${t.id}`}>
                              {STATUS_LABELS[t.status] || t.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap" data-testid={`ct-orders-date-${t.id}`}>
                            {fmtDate(t.createdAt)}
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={10} className="p-3 bg-slate-950/40 border-b border-slate-700/60">
                              {renderDetail(t)}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Compact order cards for phones/tablets */}
            <div className="lg:hidden space-y-2" data-testid="ct-orders-cards">
              {orderRows.map((t) => {
                const open = !!expanded[t.id];
                const items = Array.isArray(t.items) ? t.items : [];
                return (
                  <div key={t.id} className="bg-slate-800/90 border border-slate-700/80 rounded-xl overflow-hidden" data-testid={`ct-orders-card-${t.id}`}>
                    <button
                      onClick={() => setExpanded((s) => ({ ...s, [t.id]: !open }))}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-slate-700/30 text-left"
                      data-testid={`ct-expandm-${t.id}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] font-black text-cyan-300">{t.trackingCode}</span>
                          {chipsFor(t)}
                        </span>
                        <span className="block text-[11px] font-bold text-white mt-0.5 truncate">
                          {t.customerName} · {fmt(t.totalGhs)} · {items.length} item{items.length === 1 ? "" : "s"}
                        </span>
                        <span className="block text-[9px] text-slate-500">
                          {t.orderRef || `#${t.id}`} · {t.businessName}{t.branchName ? ` · ${t.branchName}` : ""} · {fmtDate(t.createdAt)}
                          {t.deliveryLat != null ? " · 📍pinned" : ""}
                        </span>
                      </span>
                      <span className={`text-[10px] font-black px-2 py-1 rounded-full border shrink-0 ${STATUS_STYLES[t.status] || STATUS_STYLES.RECEIVED}`}>
                        {STATUS_LABELS[t.status] || t.status}
                      </span>
                      {open ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />}
                    </button>
                    {open && <div className="px-3 pb-3">{renderDetail(t)}</div>}
                  </div>
                );
              })}
            </div>
          </>
        )
      )}

      {/* ── LIVE TRACKING console ── */}
      {view === "CONSOLE" && (
        loading ? (
          <div className="text-center text-slate-400 text-xs py-10">Loading trackings…</div>
        ) : baseFiltered.length === 0 ? (
          <div className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-8 text-center" data-testid="ct-empty">
            <Truck className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-300">No trackings yet</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Every recorded sale automatically gets one — or create a phone/order booking with “New Tracking”.
            </p>
          </div>
        ) : (
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl" data-testid="ct-table">
            {baseFiltered.map((t, idx) => {
              const open = !!expanded[t.id];
              return (
                <div key={t.id} className={idx > 0 ? "border-t border-slate-700/60" : ""} data-testid={`ct-row-${t.id}`}>
                  <button
                    onClick={() => setExpanded((s) => ({ ...s, [t.id]: !open }))}
                    className="w-full flex items-center gap-3 px-3.5 py-3 hover:bg-slate-700/30 text-left"
                    data-testid={`ct-live-expand-${t.id}`}
                  >
                    <span className="font-mono text-[11px] font-black text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded px-1.5 py-1 shrink-0">
                      {t.trackingCode}
                    </span>
                    {chipsFor(t)}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-bold text-white">{t.customerName}</span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {t.businessName} {t.branchName ? `· ${t.branchName}` : ""} · {(t.items || []).length} item{(t.items || []).length === 1 ? "" : "s"}
                        {t.totalGhs != null ? ` · ${fmt(t.totalGhs)}` : ""}
                      </span>
                    </span>
                    <span className={`text-[10px] font-black px-2 py-1 rounded-full border shrink-0 ${STATUS_STYLES[t.status] || STATUS_STYLES.RECEIVED}`}>
                      {STATUS_LABELS[t.status] || t.status}
                    </span>
                    {open ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />}
                  </button>
                  {open && <div className="px-3.5 pb-4">{renderDetail(t)}</div>}
                </div>
              );
            })}
          </div>
        )
      )}

      {showNew && (
        <NewTrackingModal
          businesses={scopedBusinesses}
          lockedBusiness={lockedBusiness}
          currentUser={currentUser}
          onClose={() => setShowNew(false)}
          onCreated={async (code: string) => {
            setShowNew(false);
            await load(true);
          }}
          fmt={fmt}
        />
      )}
    </div>
  );
}

/* ───────────────────────── New Tracking modal ───────────────────────── */

function NewTrackingModal({
  businesses,
  lockedBusiness,
  currentUser,
  onClose,
  onCreated,
  fmt,
}: {
  businesses: any[];
  lockedBusiness?: any | null;
  currentUser: any;
  onClose: () => void;
  onCreated: (code: string) => void;
  fmt: (n: any) => string;
}) {
  const [bizId, setBizId] = useState<string>(
    String(lockedBusiness?.id || businesses[0]?.id || ""),
  );
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [phoneErr, setPhoneErr] = useState("");
  const [fulfillment, setFulfillment] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [destination, setDestination] = useState("");
  const [mapLinkText, setMapLinkText] = useState("");
  const [items, setItems] = useState<{ description: string; quantity: string; unitPrice: string }[]>([
    { description: "", quantity: "1", unitPrice: "" },
  ]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdCode, setCreatedCode] = useState("");
  const [copied, setCopied] = useState(false);

  // Staff can paste a Google Maps share link / coordinates the customer sent.
  const parsedPin = useMemo(() => parseGoogleMapsPin(mapLinkText), [mapLinkText]);
  const pinTried = mapLinkText.trim().length > 0;

  const [discountPct, setDiscountPct] = useState(""); // % discount — amount auto-calculated
  const subtotal = items.reduce(
    (acc, li) => acc + (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0),
    0,
  );
  const discountPctNum = Math.max(0, Math.min(100, Number(discountPct) || 0));
  const discountAmount = Math.round(((subtotal * discountPctNum) / 100) * 100) / 100;
  const total = Math.round((subtotal - discountAmount) * 100) / 100;

  const submit = async () => {
    setError("");
    const cleanItems = items
      .filter((li) => li.description.trim())
      .map((li) => ({
        description: li.description.trim(),
        quantity: Number(li.quantity) || 1,
        unitPrice: Number(li.unitPrice) || 0,
      }));
    if (!bizId) return setError("Choose the business this order belongs to.");
    if (cleanItems.length === 0) return setError("Add at least one product line.");
    if (phoneErr) return setError(phoneErr);
    if (customerPhone.trim()) {
      const v = validatePhone(customerPhone);
      if (!v.ok) {
        setPhoneErr(v.error);
        return setError(v.error);
      }
    }
    setBusy(true);
    try {
      const res = await fetch("/api/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "CREATE",
          businessId: Number(bizId),
          customerName: customerName.trim() || "Walk-in Customer",
          customerPhone: customerPhone.trim(),
          items: cleanItems,
          ...(discountPctNum > 0 ? { discountPercent: discountPctNum } : {}),
          fulfillmentType: fulfillment,
          destinationAddress: destination.trim(),
          ...(fulfillment === "DELIVERY" && parsedPin
            ? { deliveryLat: parsedPin.lat, deliveryLng: parsedPin.lng }
            : {}),
          note: note.trim(),
        }),
      });
      const data = await res.json();
      if (data?.success) {
        setCreatedCode(data.tracking.trackingCode);
      } else {
        setError(data?.error || "Could not create the tracking.");
      }
    } catch {
      setError("Network error while creating the tracking.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" data-testid="ct-new-root">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/70 sticky top-0 bg-slate-900 z-10">
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <Truck className="w-4 h-4 text-cyan-300" /> New Customer Order & Tracking
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400" data-testid="ct-new-cancel">
            <X className="w-4 h-4" />
          </button>
        </div>

        {createdCode ? (
          <div className="p-5 text-center space-y-3" data-testid="ct-new-result">
            <PackageCheck className="w-10 h-10 text-emerald-400 mx-auto" />
            <p className="text-sm font-bold text-white">Tracking created — give this code to the customer</p>
            <div className="font-mono text-xl font-black text-cyan-300 bg-cyan-500/10 border border-cyan-500/40 rounded-xl px-4 py-3" data-testid="ct-new-code">
              {createdCode}
            </div>
            <p className="text-[11px] text-slate-400">
              They follow it live at <span className="text-cyan-300 font-semibold">{typeof window !== "undefined" ? window.location.origin : ""}/track</span> — no login needed.
            </p>
            <div className="flex justify-center gap-2">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(createdCode);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700/70 border border-slate-600 text-slate-200 text-xs font-bold"
                data-testid="ct-new-copy"
              >
                <Copy className="w-3.5 h-3.5" /> {copied ? "Copied!" : "Copy code"}
              </button>
              <button
                onClick={() => onCreated(createdCode)}
                className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                data-testid="ct-new-done"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Business / Branch</label>
              <select
                value={bizId}
                onChange={(e) => setBizId(e.target.value)}
                disabled={!!lockedBusiness}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 disabled:opacity-60"
                data-testid="ct-new-biz"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}{b.branchLocation ? ` — ${b.branchLocation}` : ""}{b.code ? ` (${b.code})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Customer name</label>
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Ama Serwaa"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60"
                  data-testid="ct-new-customer"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Phone (optional)</label>
                <input
                  value={customerPhone}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomerPhone(v);
                    setPhoneErr(v.trim() ? validatePhone(v).error : "");
                  }}
                  placeholder="024…"
                  inputMode="tel"
                  className={`w-full bg-slate-800 border ${phoneErr ? "border-rose-500/70 focus:border-rose-500" : "border-slate-700 focus:border-cyan-500/60"} rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60`}
                  data-testid="ct-new-phone"
                />
                {phoneErr && (
                  <p className="mt-1 text-[10px] font-bold text-rose-300" data-testid="ct-new-phone-error">{phoneErr}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Fulfilment</label>
                <select
                  value={fulfillment}
                  onChange={(e) => setFulfillment(e.target.value as any)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200"
                  data-testid="ct-new-fulfillment"
                >
                  <option value="PICKUP">Pickup at branch</option>
                  <option value="DELIVERY">Delivery (live map)</option>
                </select>
              </div>
              {fulfillment === "DELIVERY" ? (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Delivery destination</label>
                  <input
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="e.g. Kasoa, near the market"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60"
                    data-testid="ct-new-dest"
                  />
                </div>
              ) : (
                <div />
              )}
            </div>

            {fulfillment === "DELIVERY" && (
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Google Maps pin (optional)
                </label>
                <input
                  value={mapLinkText}
                  onChange={(e) => setMapLinkText(e.target.value)}
                  placeholder="Paste the Google Maps link the customer sent, or 5.6037, -0.1870"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60"
                  data-testid="ct-new-maplink"
                />
                {pinTried && parsedPin && (
                  <div className="mt-1.5 space-y-1.5" data-testid="ct-new-pin">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300" data-testid="ct-new-pin-chip">
                      <MapPin className="w-3 h-3" /> Pin: {parsedPin.lat.toFixed(6)}, {parsedPin.lng.toFixed(6)}
                    </span>
                    <div className="rounded-lg overflow-hidden border border-slate-700">
                      <iframe
                        key={`${parsedPin.lat},${parsedPin.lng}`}
                        title="Delivery pin preview — Google Maps"
                        src={googleMapsEmbed(parsedPin.lat, parsedPin.lng, 16)}
                        className="w-full h-[160px] bg-slate-800"
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        data-testid="ct-new-pin-map"
                      />
                    </div>
                  </div>
                )}
                {pinTried && !parsedPin && (
                  <p className="mt-1 text-[10px] text-amber-300/90" data-testid="ct-new-pin-bad">
                    Link not recognised — the order will keep the typed address only (no map pin).
                  </p>
                )}
                <p className="mt-1 text-[9px] text-slate-500">
                  Ask the customer to share their location pin from Google Maps (Share → copy link) and paste it here.
                </p>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Products</label>
                <button
                  onClick={() => setItems((s) => [...s, { description: "", quantity: "1", unitPrice: "" }])}
                  className="flex items-center gap-1 text-[10px] font-bold text-cyan-300 hover:text-cyan-200"
                  data-testid="ct-item-add"
                >
                  <Plus className="w-3 h-3" /> Add line
                </button>
              </div>
              <div className="space-y-1.5">
                {items.map((li, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      value={li.description}
                      onChange={(e) => setItems((s) => s.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                      placeholder="Product / service…"
                      className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-cyan-500/60"
                      data-testid={`ct-item-desc-${i}`}
                    />
                    <input
                      value={li.quantity}
                      onChange={(e) => setItems((s) => s.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                      inputMode="numeric"
                      className="w-14 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 text-center outline-none"
                      title="Qty"
                      data-testid={`ct-item-qty-${i}`}
                    />
                    <input
                      value={li.unitPrice}
                      onChange={(e) => setItems((s) => s.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
                      inputMode="decimal"
                      placeholder="₵ price"
                      className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 outline-none"
                      data-testid={`ct-item-price-${i}`}
                    />
                    <button
                      onClick={() => setItems((s) => s.filter((_, j) => j !== i))}
                      disabled={items.length === 1}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 disabled:opacity-30"
                      data-testid={`ct-item-remove-${i}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-right text-[11px] font-bold text-emerald-300" data-testid="ct-new-total">
                Total: {fmt(total)}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Discount % (optional — amount auto-calculates)</label>
              <div className="flex items-center gap-2">
                <input
                  value={discountPct}
                  onChange={(e) => setDiscountPct(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 5"
                  className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60"
                  data-testid="ct-new-discount"
                />
                {discountAmount > 0 && (
                  <span className="text-[11px] text-amber-300" data-testid="ct-new-discount-amount">
                    − {fmt(discountAmount)} · customer pays {fmt(total)}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">First note (optional)</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Ready tomorrow morning"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500/60"
                data-testid="ct-new-note"
              />
            </div>

            {error && <p className="text-[11px] text-rose-300" data-testid="ct-new-error">{error}</p>}

            <button
              onClick={submit}
              disabled={busy}
              className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow disabled:opacity-40"
              data-testid="ct-new-submit"
            >
              {busy ? "Creating…" : "Create tracking code"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
