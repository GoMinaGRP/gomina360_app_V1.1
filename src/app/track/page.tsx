"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  PackageSearch,
  Search,
  ClipboardList,
  CheckCircle2,
  Cog,
  PackageCheck,
  Truck,
  MapPin,
  Bell,
  BellOff,
  Copy,
  Clock3,
  XCircle,
  Store,
  RefreshCw,
  User as UserIcon,
  Banknote,
  HandCoins,
  Navigation,
  Phone,
  Smartphone,
} from "lucide-react";
import { googleMapsEmbed, googleMapsLink, googleMapsRouteLink } from "@/lib/tracking";
import { qrDataUrl } from "@/lib/qrRegistry";

const STEP_DEFS = [
  { key: "RECEIVED", label: "Order Received", icon: ClipboardList },
  { key: "CONFIRMED", label: "Confirmed", icon: CheckCircle2 },
  { key: "PROCESSING", label: "Processing", icon: Cog },
  { key: "READY", label: "Ready / Dispatched", icon: Truck },
  { key: "DONE", label: "Delivered / Completed", icon: PackageCheck },
];

function fmtMoney(amount: number | null | undefined, currency: string) {
  if (amount == null) return "—";
  if (currency === "GHS") return `GH₵ ${Number(amount).toFixed(2)}`;
  return `${currency} ${Number(amount).toFixed(2)}`;
}

function ago(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function TrackInner() {
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("code") || "");
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareQr, setShareQr] = useState("");
  const prevStatusRef = useRef<string | null>(null);
  const resultRef = useRef<any | null>(null);

  // Scannable QR of this order's tracking link — share it with whoever is
  // receiving the delivery, or print it for the parcel.
  useEffect(() => {
    let on = true;
    if (result?.trackUrl && typeof window !== "undefined") {
      qrDataUrl(window.location.origin + result.trackUrl, 260)
        .then((d) => on && setShareQr(d))
        .catch(() => {});
    } else {
      setShareQr("");
    }
    return () => { on = false; };
  }, [result]);
  resultRef.current = result;

  const fetchTracking = useCallback(async (lookupCode: string, opts?: { announce?: boolean }) => {
    const trimmed = lookupCode.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/track?code=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      const data = await res.json();
      if (data?.success) {
        const t = data.tracking;
        // Customer notification: status changed since last poll.
        if (
          opts?.announce &&
          prevStatusRef.current &&
          prevStatusRef.current !== t.status &&
          notifyOn &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            new Notification(`Order ${t.code}: ${t.statusLabel}`, {
              body: `${t.businessName}${t.branchName ? ` — ${t.branchName}` : ""}. Tap to view the latest update.`,
              tag: `gomina-track-${t.code}`,
            });
          } catch {}
        }
        prevStatusRef.current = t.status;
        setResult(t);
        setError("");
      } else {
        setResult(null);
        setError(data?.error || "No order found for that tracking code.");
      }
    } catch {
      if (!opts?.announce) {
        setResult(null);
        setError("Could not reach the tracking service. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [notifyOn]);

  // Auto-load ?code= from staff-shared links.
  useEffect(() => {
    const initial = (params.get("code") || "").trim();
    if (initial) fetchTracking(initial, { announce: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live refresh: poll every 15s while an open order is on screen.
  useEffect(() => {
    const t = setInterval(() => {
      const r = resultRef.current;
      if (!r || r.isTerminal) return;
      if (typeof document !== "undefined" && document.hidden) return;
      fetchTracking(r.code, { announce: true });
    }, 15000);
    return () => clearInterval(t);
  }, [fetchTracking]);

  const toggleNotify = async () => {
    if (notifyOn) return setNotifyOn(false);
    if (typeof Notification === "undefined") return;
    try {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setNotifyOn(perm === "granted");
    } catch {
      setNotifyOn(false);
    }
  };

  const t = result;
  const isCancelled = t?.status === "CANCELLED";
  const scopeItems = t?.items || [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Customer-facing header — deliberately separate from the staff dashboard */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center font-black text-white text-sm shadow-lg">
            360
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-extrabold text-white leading-tight">GoMina 360 · Order Tracking</div>
            <div className="text-[10px] text-emerald-300/90 leading-tight">Official customer page — no sign-in needed</div>
          </div>
          <a href="/order" className="text-[11px] font-bold text-cyan-300 hover:text-cyan-200 underline decoration-cyan-500/40" data-testid="track-order-link">
            Order online →
          </a>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        {/* Lookup card */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
          <h1 className="text-lg font-black text-white flex items-center gap-2">
            <PackageSearch className="w-5 h-5 text-cyan-300" /> Track your order
          </h1>
          <p className="text-[11px] text-slate-400 mt-1">
            Enter the tracking code the staff gave you (it is on your receipt, e.g. <span className="font-mono text-cyan-300">GM-POULTRY-4K7XQ2</span>).
            You will only ever see information linked to your own code.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchTracking(code, { announce: false });
            }}
            className="mt-3 flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="GM-…"
                autoCapitalize="characters"
                className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 focus:border-cyan-500/60 rounded-xl text-sm text-white font-mono uppercase outline-none transition"
                data-testid="track-input"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white text-sm font-bold shadow-lg disabled:opacity-40"
              data-testid="track-submit"
            >
              {loading ? "…" : "Track"}
            </button>
          </form>
          {error && (
            <div className="mt-3 px-3 py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2" data-testid="track-error">
              <XCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}
        </section>

        {t && (
          <section className="space-y-4" data-testid="track-result">
            {/* Current status card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tracking code</div>
                  <div className="font-mono text-base font-black text-cyan-300" data-testid="track-code">{t.code}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={toggleNotify}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition ${
                      notifyOn
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                        : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
                    }`}
                    data-testid="track-notify-toggle"
                    title="Get a notification on this device when the status changes"
                  >
                    {notifyOn ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
                    {notifyOn ? "Updates on" : "Notify me"}
                  </button>
                  <button
                    onClick={() => fetchTracking(t.code, { announce: false })}
                    className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
                    title="Refresh now"
                    data-testid="track-refresh"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>

              {isCancelled ? (
                <div className="mt-4 px-3 py-3 rounded-xl bg-rose-500/10 border border-rose-500/40" data-testid="track-cancelled">
                  <div className="text-sm font-black text-rose-300 flex items-center gap-2">
                    <XCircle className="w-4 h-4" /> This order was cancelled
                  </div>
                  <p className="text-[11px] text-rose-200/70 mt-1">Please contact the business for details.</p>
                </div>
              ) : (
                <>
                  {/* 5-step journey stepper */}
                  <div className="mt-5" data-testid="track-stepper">
                    <ol className="flex items-start">
                      {STEP_DEFS.map((s, i) => {
                        const reached = (t.journeyStep ?? 0) >= i;
                        const current = (t.journeyStep ?? 0) === i && !t.isTerminal;
                        const Icon = s.icon;
                        return (
                          <li key={s.key} className="flex-1 relative" data-testid={`track-step-${i}`}>
                            {i > 0 && (
                              <span className={`absolute left-0 right-1/2 top-4 h-0.5 -translate-x-1/2 ${reached ? "bg-emerald-500" : "bg-slate-700"}`} style={{ left: "-50%", right: "50%" }} />
                            )}
                            <div className="relative flex flex-col items-center text-center px-0.5">
                              <span
                                className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition ${
                                  reached
                                    ? "bg-emerald-500/20 border-emerald-400 text-emerald-300"
                                    : "bg-slate-800 border-slate-700 text-slate-500"
                                } ${current ? "ring-2 ring-emerald-400/50 animate-pulse" : ""}`}
                              >
                                <Icon className="w-4 h-4" />
                              </span>
                              <span className={`mt-1.5 text-[9px] sm:text-[10px] font-bold leading-tight ${reached ? "text-emerald-300" : "text-slate-500"}`}>
                                {s.label}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                  <div className="mt-4 text-center">
                    <span className="inline-block text-xs font-black px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300" data-testid="track-status">
                      {t.statusLabel}
                    </span>
                    <div className="text-[10px] text-slate-500 mt-1.5">
                      Updated {ago(t.updatedAt)} · refreshes automatically{t.isTerminal ? "" : " every 15 seconds"}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Live dispatch map (Google Maps) — only while the order is on the road */}
            {t.live && (
              <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-map">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-cyan-300" /> Your order is on its way — live location
                  </h2>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-cyan-300">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" /> LIVE · updated {ago(t.live.at)}
                  </span>
                </div>
                <div className="mt-3 rounded-xl overflow-hidden border border-slate-700">
                  <iframe
                    key={`${t.live.lat},${t.live.lng}`}
                    title="Live delivery location (Google Maps)"
                    src={`https://maps.google.com/maps?q=${t.live.lat},${t.live.lng}&z=15&hl=en&output=embed`}
                    className="w-full h-[300px] bg-slate-800"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    data-testid="track-map-frame"
                  />
                </div>
                <div className="mt-2 text-[11px] text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                  {t.live.driverName && (
                    <span className="flex items-center gap-1"><UserIcon className="w-3 h-3" /> Courier: {t.live.driverName}</span>
                  )}
                  {t.live.vehicleNote && <span>Vehicle: {t.live.vehicleNote}</span>}
                  {t.destinationAddress && (
                    <span className="flex items-center gap-1"><PackageCheck className="w-3 h-3" /> Delivering to: {t.destinationAddress}</span>
                  )}
                  {t.deliveryLocation && (
                    <a
                      href={googleMapsRouteLink(t.live.lat, t.live.lng, t.deliveryLocation.lat, t.deliveryLocation.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 font-bold text-emerald-300 hover:text-emerald-200 underline decoration-emerald-500/40"
                      data-testid="track-route-link"
                    >
                      <Navigation className="w-3 h-3" /> Follow the courier's route to your pinned point
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Delivery destination — the customer's own Google-Maps pin */}
            {t.fulfillmentType === "DELIVERY" && t.deliveryLocation && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-delivery-map">
                <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-2">
                  <MapPin className="w-4 h-4 text-cyan-300" /> Your delivery point
                </h2>
                <div className="rounded-xl overflow-hidden border border-slate-700">
                  <iframe
                    key={`${t.deliveryLocation.lat},${t.deliveryLocation.lng}`}
                    title="Your pinned delivery point — Google Maps"
                    src={googleMapsEmbed(t.deliveryLocation.lat, t.deliveryLocation.lng, 17)}
                    className="w-full h-[240px] bg-slate-800"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    data-testid="track-delivery-map-frame"
                  />
                </div>
                <div className="mt-2 text-[11px] text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {t.destinationAddress && <span className="flex items-center gap-1"><PackageCheck className="w-3 h-3" /> {t.destinationAddress}</span>}
                  <span className="font-mono text-[10px] text-cyan-300/90" data-testid="track-delivery-coords">
                    {Number(t.deliveryLocation.lat).toFixed(6)}, {Number(t.deliveryLocation.lng).toFixed(6)}
                    {t.deliveryLocation.accuracyM ? ` · GPS ±${Math.round(t.deliveryLocation.accuracyM)} m` : ""}
                  </span>
                  <a
                    href={t.deliveryLocation.mapLink || googleMapsLink(t.deliveryLocation.lat, t.deliveryLocation.lng)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 font-bold text-cyan-300 hover:text-cyan-200 underline decoration-cyan-500/40"
                    data-testid="track-delivery-open"
                  >
                    <Navigation className="w-3 h-3" /> Open in Google Maps
                  </a>
                </div>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  Only you (with this tracking code) and the team delivering your order can see this pin.
                </p>
              </div>
            )}

            {/* Pickup point — the chosen pickup location (or the branch itself) */}
            {t.fulfillmentType === "PICKUP" && t.pickupLocation && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-pickup-map">
                <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-2">
                  <Store className="w-4 h-4 text-emerald-300" /> Where to pick up
                </h2>
                {t.pickupLocation.name && (
                  <p className="text-[12px] font-bold text-emerald-300 mb-2" data-testid="track-pickpoint-name">
                    {t.pickupLocation.name}
                  </p>
                )}
                {t.pickupLocation.lat != null && t.pickupLocation.lng != null && (
                  <div className="rounded-xl overflow-hidden border border-slate-700">
                    <iframe
                      key={`${t.pickupLocation.lat},${t.pickupLocation.lng}`}
                      title="Pickup point — Google Maps"
                      src={googleMapsEmbed(t.pickupLocation.lat, t.pickupLocation.lng, 16)}
                      className="w-full h-[240px] bg-slate-800"
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      data-testid="track-pickup-map-frame"
                    />
                  </div>
                )}
                <div className="mt-2 text-[11px] text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {t.pickupLocation.address && <span>{t.pickupLocation.address}</span>}
                  {t.pickupLocation.lat != null && t.pickupLocation.lng != null && (
                    <a
                      href={t.pickupLocation.mapLink || googleMapsLink(t.pickupLocation.lat, t.pickupLocation.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 font-bold text-emerald-300 hover:text-emerald-200 underline decoration-emerald-500/40"
                      data-testid="track-pickup-directions"
                    >
                      <Navigation className="w-3 h-3" /> Get directions
                    </a>
                  )}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  Come in when your order shows “Ready for Pickup” above — this is the branch's public location.
                </p>
              </div>
            )}

            {/* Order & business card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
              <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-3">
                <Store className="w-4 h-4 text-emerald-300" /> Order details
              </h2>
              <div className="grid grid-cols-2 gap-2 text-[11px] mb-3">
                <div className="bg-slate-800/60 rounded-lg p-2.5">
                  <div className="text-slate-500 font-bold text-[9px] uppercase tracking-wider">Business</div>
                  <div className="text-slate-200 font-bold mt-0.5">{t.businessName}</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-2.5">
                  <div className="text-slate-500 font-bold text-[9px] uppercase tracking-wider">Branch</div>
                  <div className="text-slate-200 font-bold mt-0.5">{t.branchName || "Main branch"}</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-2.5">
                  <div className="text-slate-500 font-bold text-[9px] uppercase tracking-wider">Customer</div>
                  <div className="text-slate-200 font-bold mt-0.5">{t.customerName}</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-2.5">
                  <div className="text-slate-500 font-bold text-[9px] uppercase tracking-wider">Fulfilment</div>
                  <div className="text-slate-200 font-bold mt-0.5">
                    {t.fulfillmentType === "DELIVERY" ? "Delivery" : "Pickup"}
                    {t.fulfillmentType === "DELIVERY" && t.destinationAddress ? ` → ${t.destinationAddress}` : ""}
                  </div>
                </div>
              </div>

              {scopeItems.length > 0 && (
                <table className="w-full text-left text-xs" data-testid="track-items">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                      <th className="py-1.5">Product</th>
                      <th className="py-1.5 text-center">Qty</th>
                      <th className="py-1.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scopeItems.map((li: any, i: number) => (
                      <tr key={i} className="border-b border-slate-800/60">
                        <td className="py-2 text-slate-200">{li.description}</td>
                        <td className="py-2 text-center text-slate-400">{li.quantity}{li.unit ? ` ${li.unit}` : ""}</td>
                        <td className="py-2 text-right text-slate-300 font-semibold">{fmtMoney(li.total, t.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {Number(t.discountGhs) > 0 && (
                      <>
                        <tr>
                          <td colSpan={2} className="pt-2 text-right font-bold text-slate-500">Subtotal</td>
                          <td className="pt-2 text-right font-semibold text-slate-300" data-testid="track-subtotal">{fmtMoney(t.subtotalGhs, t.currency)}</td>
                        </tr>
                        <tr>
                          <td colSpan={2} className="text-right font-bold text-slate-500">
                            Discount{Number(t.discountPercent) > 0 ? ` (${Number(t.discountPercent)}%)` : ""}
                          </td>
                          <td className="text-right font-semibold text-amber-300" data-testid="track-discount">
                            − {fmtMoney(t.discountGhs, t.currency)}
                          </td>
                        </tr>
                      </>
                    )}
                    <tr data-testid="track-total-row">
                      <td colSpan={2} className="py-2 text-right font-bold text-slate-400">Total</td>
                      <td className="py-2 text-right font-black text-emerald-300">{fmtMoney(t.totalGhs, t.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500">
                <Clock3 className="w-3 h-3" /> Placed {t.placedAt ? new Date(t.placedAt).toLocaleString() : "—"}
              </div>
            </div>

            {/* Payment status & delivery progress for the customer */}
            {t.payment && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-payment">
                <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-2">
                  <Banknote className="w-4 h-4 text-emerald-300" /> Payment
                </h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[11px] font-black px-2.5 py-1 rounded-full border ${
                      t.payment.status === "PAID"
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                        : t.payment.status === "PENDING_CONFIRMATION"
                        ? "bg-yellow-500/15 border-yellow-500/40 text-yellow-300"
                        : "bg-amber-500/15 border-amber-500/40 text-amber-300"
                    }`}
                    data-testid="track-payment-status"
                  >
                    {t.payment.label}
                  </span>
                  <span className="text-[11px] text-slate-400">{t.payment.explainer}</span>
                </div>
                {t.status === "DISPATCHED" && t.fulfillmentType === "DELIVERY" && (
                  <div className="mt-2 text-[11px] text-cyan-300 flex items-center gap-1.5" data-testid="track-delivery-progress">
                    <Truck className="w-3.5 h-3.5" /> Delivery in progress — watch the live map above.
                  </div>
                )}
                {/* Business telephone for payment assistance / delivery
                    support — set per unit by the OWNER / authorized staff and
                    shown right under the Payment status block. */}
                {t.help?.phone && (
                  <a
                    href={`tel:${String(t.help.phone).replace(/[^+\d]/g, "")}`}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1.5 text-[12px] font-bold text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/15 transition"
                    data-testid="track-payment-call"
                  >
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Payment assistance or delivery support — call{" "}
                      <span className="font-black">{t.help.phone}</span>
                    </span>
                  </a>
                )}
              </div>
            )}

            {/* Credit sale — installment plan, dated history & outstanding balance */}
            {t.credit && (
              <div className="bg-slate-900 border border-cyan-500/30 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-credit-card">
                <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-2">
                  <HandCoins className="w-4 h-4 text-cyan-300" /> Credit sale — {t.credit.statusLabel}
                </h2>
                <div className="grid grid-cols-3 gap-2 text-center mb-2">
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-2.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Total</p>
                    <p className="text-[13px] font-black text-white" data-testid="track-credit-total">
                      GH₵{Number(t.credit.totalGhs).toFixed(2)}
                    </p>
                  </div>
                  <div className="bg-slate-950/60 border border-emerald-500/25 rounded-xl p-2.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-400">Paid so far</p>
                    <p className="text-[13px] font-black text-emerald-300" data-testid="track-credit-paid">
                      GH₵{Number(t.credit.amountPaidGhs).toFixed(2)}
                    </p>
                  </div>
                  <div className="bg-slate-950/60 border border-amber-500/25 rounded-xl p-2.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-amber-400">Outstanding</p>
                    <p className="text-[13px] font-black text-amber-300" data-testid="track-credit-balance">
                      GH₵{Number(t.credit.balanceGhs).toFixed(2)}
                    </p>
                  </div>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden border border-slate-700 mb-1" data-testid="track-credit-progress">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${t.credit.progressPercent}%` }} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500 mb-2">
                  <span>{t.credit.progressPercent}% paid</span>
                  {t.credit.dueDate && <span data-testid="track-credit-due">Agreed settlement: {t.credit.dueDate}</span>}
                </div>
                {t.credit.status === "ACTIVE" ? (
                  <p className="text-[11px] text-cyan-200/90 mb-2" data-testid="track-credit-how">
                    To pay an installment, send MoMo to the business payment number below (quote your tracking code
                    as reference), call the business, or pay at the branch — every payment shows up here instantly.
                  </p>
                ) : (
                  <p className="text-[11px] text-emerald-300 font-bold mb-2" data-testid="track-credit-settled">
                    Fully paid{t.credit.paidAt ? ` on ${new Date(t.credit.paidAt).toLocaleDateString()}` : ""} — thank you!
                  </p>
                )}
                {t.credit.payments && t.credit.payments.length > 0 && (
                  <div data-testid="track-credit-history">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Your payments</p>
                    <div className="space-y-1">
                      {t.credit.payments.map((p: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-[11px] bg-slate-950/60 border border-slate-800 rounded-lg px-2.5 py-1.5">
                          <span className="text-slate-400">{p.at ? new Date(p.at).toLocaleString() : "—"}</span>
                          <span className="font-bold text-emerald-300">GH₵{Number(p.amountGhs).toFixed(2)}</span>
                          <span className="text-slate-400">{p.method === "MTN_MOMO" ? "MTN MoMo" : p.method === "CASH" ? "Cash" : p.method === "TELECEL_CASH" ? "Telecel Cash" : p.method === "BANK_TRANSFER" ? "Bank" : p.method === "POS_CARD" ? "POS" : p.method}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Customer help & MoMo payment — set per branch by the owner */}
            {(t.help || t.momo) && (
              <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-4 sm:p-5 shadow-xl" data-testid="track-contacts">
                <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-2">
                  <Smartphone className="w-4 h-4 text-amber-300" /> Help & payment for this order
                </h2>
                {t.momo && (
                  <p className="text-[12px] text-amber-200 mb-1" data-testid="track-momo">
                    Pay MoMo to <span className="font-black">{t.momo.number}</span>
                    {t.momo.name ? ` — ${t.momo.name}` : ""}. Quote your tracking code as reference.
                  </p>
                )}
                {t.help && (
                  <p className="text-[12px] text-amber-100/90" data-testid="track-help">
                    Questions about your order? Call / WhatsApp <span className="font-black">{t.help.phone}</span>
                  </p>
                )}
              </div>
            )}

            {/* Timeline = the customer's status-update feed */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
              <h2 className="text-sm font-extrabold text-white flex items-center gap-2 mb-3">
                <Clock3 className="w-4 h-4 text-emerald-300" /> Status updates
              </h2>
              <ol className="space-y-3" data-testid="track-timeline">
                {[...(t.history || [])].reverse().map((h: any, i: number) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className={`mt-0.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0 border ${i === 0 ? "bg-emerald-500/20 border-emerald-400 text-emerald-300" : "bg-slate-800 border-slate-700 text-slate-500"}`}>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className={`text-xs font-bold ${i === 0 ? "text-white" : "text-slate-300"}`}>{h.label}</div>
                      <div className="text-[10px] text-slate-500">{h.at ? new Date(h.at).toLocaleString() : ""} · {h.by}</div>
                      {h.note && <div className="text-[11px] text-slate-400 italic mt-0.5">“{h.note}”</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Share */}
            <div className="flex flex-col items-center gap-2.5 pb-4">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.origin + t.trackUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] font-bold"
                data-testid="track-copy"
              >
                <Copy className="w-3.5 h-3.5" /> {copied ? "Link copied!" : "Copy tracking link"}
              </button>
              {shareQr && (
                <div className="text-center" data-testid="track-qr">
                  <img
                    src={shareQr}
                    alt="QR code linking to this order's tracking page"
                    width={132}
                    height={132}
                    className="rounded-xl border border-slate-700 bg-white p-2 mx-auto"
                    data-testid="track-qr-img"
                  />
                  <p className="text-[9px] text-slate-500 mt-1.5 max-w-[180px]">
                    Scan with any phone camera to open this exact tracking page — no sign-in needed.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        <footer className="pt-2 pb-8 text-center text-[10px] text-slate-600" data-testid="track-footer">
          Powered by GoMina 360 · Enterprise Command Center · This is a customer-only page — no
          sign-in is ever needed to order or to track an order.
        </footer>
      </main>
    </div>
  );
}

export default function PublicTrackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
          Loading order tracking…
        </div>
      }
    >
      <TrackInner />
    </Suspense>
  );
}
