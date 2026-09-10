"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ShoppingCart,
  Search,
  Store,
  Plus,
  Minus,
  Trash2,
  X,
  PackageCheck,
  Copy,
  Truck,
  Banknote,
  Smartphone,
  MapPin,
  Navigation,
  Globe,
  ZoomIn,
  ChevronLeft,
  ChevronRight,
  User as UserIcon,
  Phone,
  ClipboardList,
  LifeBuoy,
  Mail,
  MessageCircle,
  Clock,
  Info,
} from "lucide-react";
import LocationPinPicker, { type PinValue } from "@/components/LocationPinPicker";
import { googleMapsEmbed, businessServesLocation, haversineM } from "@/lib/tracking";
import { validatePhone, PHONE_EXACT_DIGITS_STOREFRONT } from "@/lib/phone";

function fmtMoney(amount: number | null | undefined, currency = "GHS") {
  if (amount == null) return "—";
  if (currency === "GHS") return `GH₵ ${Number(amount).toFixed(2)}`;
  return `${currency} ${Number(amount).toFixed(2)}`;
}

interface CartLine {
  biz: any;
  product: any;
  qty: number;
}

/**
 * Type-in-the-quantity box for the cart stepper. Customers may tap −/+
 * or simply type a number directly. Typing is validated on the way in:
 * only digits, clamped to [1, max] on commit; an empty box while typing is
 * fine, but blurring an empty / zero box removes the line (same as tapping −
 * down to zero).
 */
function QtyInput({
  value,
  max,
  onCommit,
  testid,
}: {
  value: number;
  max: number;
  onCommit: (qty: number) => void;
  testid: string;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // Follow external stepper changes while the field is not being edited.
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "0") return onCommit(0);
    const n = Math.floor(Number(trimmed));
    if (!Number.isFinite(n) || n <= 0) return onCommit(0);
    onCommit(Math.min(max, n));
  };

  return (
    <input
      value={text}
      inputMode="numeric"
      aria-label="Quantity"
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const v = e.target.value;
        if (!/^\d{0,4}$/.test(v)) return; // digits only
        setText(v);
        if (v !== "") commit(v);
      }}
      onBlur={() => {
        setFocused(false);
        commit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-10 bg-transparent text-center text-[13px] font-black text-slate-900 outline-none border-b border-transparent focus:border-amber-500"
      data-testid={testid}
    />
  );
}

function OrderInner() {
  const params = useSearchParams();
  const [menu, setMenu] = useState<any[] | null>(null);
  const [menuError, setMenuError] = useState("");
  const [bizId, setBizId] = useState<number | null>(null);
  // "All businesses, one page" browsing — the DEFAULT storefront view: every
  // product of every business on ONE continuous page, grouped by business →
  // category. A branch chip narrows back to a single business; a ?biz=N link
  // opens focused on that business. The cart stays single-business (stock,
  // tracking & payment are per-branch) with a confirm-then-switch guard.
  const [allMode, setAllMode] = useState(true);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("ALL");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fulfillment, setFulfillment] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  // Chosen pickup point (when the branch runs named pickup locations).
  const [pickPointId, setPickPointId] = useState<number | null>(null);
  const [destination, setDestination] = useState("");
  const [deliveryPin, setDeliveryPin] = useState<PinValue | null>(null);
  const [payChoice, setPayChoice] = useState<"ON_DELIVERY" | "MOMO_NOW">("ON_DELIVERY");
  const [momoRef, setMomoRef] = useState("");
  const [note, setNote] = useState("");
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [phoneErr, setPhoneErr] = useState("");
  const [placed, setPlaced] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  // Google-Maps "serving my location" — the customer's fix (GPS or a dropped
  // pin) used to show ONLY the businesses/branches whose delivery area
  // covers them, plus the distance to each branch.
  const [custLoc, setCustLoc] = useState<{ lat: number; lng: number; accuracyM?: number | null; source: "GPS" | "PIN" } | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [locErr, setLocErr] = useState("");
  const [locPinOpen, setLocPinOpen] = useState(false);
  const [nearOnly, setNearOnly] = useState(true);
  // HELP panel — the ONLY place customers see the "How to use" guide and the
  // group-wide customer support information (edited by the OWNER / granted
  // staff). Hidden until the HELP button is tapped.
  const [helpOpen, setHelpOpen] = useState(false);
  const [support, setSupport] = useState<any | null>(null);
  // Enlarged product image (customer tap-to-zoom lightbox) — keeps the
  // product's own business alongside it so "Add to cart" always targets the
  // correct shop, even from the one-page all-businesses grid. `idx` tracks
  // which of the product's photos the gallery is currently showing.
  const [lightbox, setLightbox] = useState<{ p: any; fromBiz?: any; idx: number } | null>(null);

  // All images registered for a product (primary photo + extras), as the
  // Amazon-style gallery source. Falls back to the legacy `photo` field.
  const productPhotos = (p: any): string[] => {
    const arr: string[] = [];
    if (typeof p.photo === "string" && p.photo.length > 0) arr.push(p.photo);
    if (Array.isArray(p.photos)) {
      for (const ph of p.photos) {
        if (typeof ph === "string" && ph.length > 0 && !arr.includes(ph)) arr.push(ph);
      }
    }
    return arr;
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/menu", { cache: "no-store" });
        const data = await res.json();
        if (data?.success) {
          setMenu(data.businesses || []);
          const wanted = Number(params.get("biz") || 0);
          const first =
            (wanted && (data.businesses || []).find((b: any) => b.businessId === wanted)?.businessId) ||
            (data.businesses || [])[0]?.businessId ||
            null;
          setBizId(first);
          setAllMode(!wanted);
        } else {
          setMenuError(data?.error || "Could not load the store.");
        }
      } catch {
        setMenuError("Could not reach the store. Check your connection and try again.");
      }
    })();
    // Customer support information for the HELP panel (public).
    (async () => {
      try {
        const res = await fetch("/api/support-info", { cache: "no-store" });
        const data = await res.json();
        if (data?.success) setSupport(data.info || null);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const biz = useMemo(() => (menu || []).find((b) => b.businessId === bizId) || null, [menu, bizId]);
  // Distance (metres) between the customer's delivery pin and the shop's own
  // GPS point — used narrowly to block "pin left exactly at the shop".
  const pinAtShopM =
    deliveryPin && biz && biz.gpsLat != null && biz.gpsLng != null
      ? haversineM(deliveryPin.lat, deliveryPin.lng, biz.gpsLat, biz.gpsLng)
      : null;
  const chosenPickPoint = useMemo(
    () => (biz?.pickupLocations || []).find((pt: any) => pt.id === pickPointId) || null,
    [biz, pickPointId],
  );
  const categories: string[] = useMemo(
    () => ["ALL", ...Array.from(new Set<string>((biz?.products || []).map((p: any) => String(p.category))))],
    [biz],
  );

  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (biz?.products || []).filter(
      (p: any) => (cat === "ALL" || p.category === cat) && (!q || p.name.toLowerCase().includes(q)),
    );
  }, [biz, cat, search]);

  // Catalog grouped by PRODUCT CATEGORY for the focused single-business view.
  const sections = useMemo(() => {
    const out: { name: string; items: any[] }[] = [];
    for (const p of products) {
      const name = String(p.category || "Other");
      let s = out.find((g) => g.name === name);
      if (!s) { s = { name, items: [] }; out.push(s); }
      s.items.push(p);
    }
    return out;
  }, [products]);

  const cartTotal = cart.reduce((acc, l) => acc + l.product.price * l.qty, 0);
  const cartCount = cart.reduce((acc, l) => acc + l.qty, 0);
  const inCart = (id: number) => cart.find((l) => l.product.id === id)?.qty || 0;

  // ── "Serving my location" (Google Maps) ─────────────────────────────
  const useMyLocation = () => {
    setLocErr("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocErr("This device has no GPS — drop a pin on the map instead.");
      setLocPinOpen(true);
      return;
    }
    setLocBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null, source: "GPS" });
        setNearOnly(true);
        setLocBusy(false);
        setLocPinOpen(false);
      },
      (err) => {
        setLocBusy(false);
        setLocErr(
          err?.code === 1
            ? "Location permission was denied — you can drop a pin on the map instead."
            : "Could not get your location — you can drop a pin on the map instead.",
        );
        setLocPinOpen(true);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  };

  const clearLoc = () => {
    setCustLoc(null);
    setLocErr("");
    setLocPinOpen(false);
    setNearOnly(true);
  };

  // Decorate each business with delivery-area evaluation for the fix.
  const decorated = useMemo(
    () =>
      (menu || []).map((b: any) =>
        custLoc
          ? { b, ...businessServesLocation(b, custLoc.lat, custLoc.lng, b.serviceAreas) }
          : { b, serves: true, distanceM: null, areaName: null },
      ),
    [menu, custLoc],
  );
  const servingCount = decorated.filter((d) => d.serves).length;
  // Near-me view: only serving branches. The currently-selected branch always
  // stays visible (QR / shared links are honoured even outside the turf), and
  // "Show all" is always one tap away.
  const visibleBiz = useMemo(
    () =>
      custLoc && nearOnly
        ? decorated.filter((d) => d.serves || d.b.businessId === bizId)
        : decorated,
    [decorated, custLoc, nearOnly, bizId],
  );

  // ALL-BUSINESSES catalog: every visible business's products grouped by
  // category, on one continuous page. Search filters across the whole grid;
  // the near-me filter (visibleBiz) is honoured exactly like the chips row.
  // In the all-businesses view the chips cover the UNION of every visible
  // business's categories — browse one category across the whole grid.
  const categoriesAllMode: string[] = useMemo(() => {
    const s = new Set<string>();
    for (const d of visibleBiz) for (const pr of d.b.products || []) s.add(String(pr.category));
    return ["ALL", ...Array.from(s)];
  }, [visibleBiz]);

  const allGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleBiz
      .map(({ b, serves, distanceM, areaName }) => {
        const its = (b.products || []).filter(
          (p: any) => (cat === "ALL" || p.category === cat) && (!q || p.name.toLowerCase().includes(q)),
        );
        const secs: { name: string; items: any[] }[] = [];
        for (const pr of its) {
          const name = String(pr.category || "Other");
          let s = secs.find((g) => g.name === name);
          if (!s) { s = { name, items: [] }; secs.push(s); }
          s.items.push(pr);
        }
        return { b, serves, distanceM, areaName, secs, count: its.length };
      })
      // Zero-product businesses never clutter the one-page grid.
      .filter((g) => g.count > 0);
  }, [visibleBiz, search, cat]);
  const allProductsCount = useMemo(
    () => allGroups.reduce((a, g) => a + g.count, 0),
    [allGroups],
  );


  // A branch's own pickup points: preselect when there is only one; any
  // branch switch resets the choice (points belong to the new branch).
  useEffect(() => {
    const pts = biz?.pickupLocations || [];
    setPickPointId(pts.length === 1 ? pts[0].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, (biz?.pickupLocations || []).length]);

  // Keep the fulfilment choice valid for the selected branch's switches.
  useEffect(() => {
    if (!biz) return;
    if (fulfillment === "DELIVERY" && biz.deliveryEnabled === false) setFulfillment("PICKUP");
    if (fulfillment === "PICKUP" && biz.pickupEnabled === false && biz.deliveryEnabled !== false) setFulfillment("DELIVERY");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId, biz?.deliveryEnabled, biz?.pickupEnabled]);

  // Esc closes the product-image lightbox and the HELP panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setLightbox(null); setHelpOpen(false); }
    };
    if (!lightbox && !helpOpen) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, helpOpen]);

  const add = (p: any, delta: number, fromBiz?: any) => {
    const pBiz = fromBiz || biz;
    // Cross-shop guard: adding a NEW line from a different business follows
    // the same confirm-then-switch rule as the branch chips (cart is
    // single-business: stock, tracking & payment are all per-branch).
    if (delta > 0 && !inCart(p.id) && cart.length > 0 && cart[0]?.biz?.businessId !== pBiz?.businessId) {
      const msg = `Your cart has items from ${cart[0]?.biz?.businessName || "another shop"}. Ordering from ${pBiz?.businessName || "this shop"} will clear it. Continue?`;
      if (typeof window !== "undefined" && !window.confirm(msg)) return;
      setCart([{ biz: pBiz, product: p, qty: 1 }]);
      if (pBiz) setBizId(pBiz.businessId);
      return;
    }
    // First item in an empty cart: checkout surfaces follow that product's
    // shop (pickup points, delivery switches, service areas).
    if (delta > 0 && !inCart(p.id) && cart.length === 0 && pBiz && pBiz.businessId !== bizId) {
      setBizId(pBiz.businessId);
    }
    setCart((c) => {
      const existing = c.find((l) => l.product.id === p.id);
      if (!existing && delta > 0) return [...c, { biz: pBiz, product: p, qty: 1 }];
      if (!existing) return c;
      const qty = Math.max(0, Math.min(p.available, existing.qty + delta));
      if (qty === 0) return c.filter((l) => l.product.id !== p.id);
      return c.map((l) => (l.product.id === p.id ? { ...l, qty } : l));
    });
  };

  // Direct (typed) quantity entry — same clamping rules as the −/+ stepper.
  const setQty = (p: any, qty: number, fromBiz?: any) => {
    const pBiz = fromBiz || biz;
    if (qty > 0 && !inCart(p.id) && cart.length > 0 && cart[0]?.biz?.businessId !== pBiz?.businessId) {
      const msg = `Your cart has items from ${cart[0]?.biz?.businessName || "another shop"}. Ordering from ${pBiz?.businessName || "this shop"} will clear it. Continue?`;
      if (typeof window !== "undefined" && !window.confirm(msg)) return;
      setCart([{ biz: pBiz, product: p, qty: Math.min(p.available, qty) }]);
      if (pBiz) setBizId(pBiz.businessId);
      return;
    }
    if (qty > 0 && !inCart(p.id) && cart.length === 0 && pBiz && pBiz.businessId !== bizId) {
      setBizId(pBiz.businessId);
    }
    setCart((c) => {
      const existing = c.find((l) => l.product.id === p.id);
      if (!existing) return qty > 0 ? [...c, { biz: pBiz, product: p, qty: Math.min(p.available, qty) }] : c;
      const q = Math.max(0, Math.min(p.available, qty));
      if (q === 0) return c.filter((l) => l.product.id !== p.id);
      return c.map((l) => (l.product.id === p.id ? { ...l, qty: q } : l));
    });
  };

  const pickBiz = (id: number) => {
    if (id === bizId) { setAllMode(false); return; }
    if (cart.length > 0 && typeof window !== "undefined" &&
        !window.confirm("Switching business will clear your cart. Continue?")) return;
    setCart([]);
    setBizId(id);
    setAllMode(false);
    setCat("ALL");
    setSearch("");
    setPickPointId(null);
    setDeliveryPin(null); // different branch — re-pin the delivery point
  };

  // Back to the all-businesses, one-page catalog (browsing only — the cart
  // is never touched by simply switching views).
  const pickAll = () => setAllMode(true);

  const placeOrder = async () => {
    setOrderError("");
    if (!biz) return setOrderError("Choose a business first.");
    if (cart.length === 0) return setOrderError("Your cart is empty.");
    if (name.trim().length < 2) return setOrderError("Please enter your name.");
    // Customer numbers are Ghana-local: EXACTLY 10 digits (no country code).
    const phoneVerdict = validatePhone(phone, { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT });
    if (!phoneVerdict.ok) {
      setPhoneErr(phoneVerdict.error);
      return setOrderError(phoneVerdict.error);
    }
    if (fulfillment === "DELIVERY" && destination.trim().length < 3)
      return setOrderError("Tell us where to deliver (area / landmark).");
    const pickPts: any[] = biz.pickupLocations || [];
    if (fulfillment === "PICKUP" && pickPts.length > 0 && !pickPointId)
      return setOrderError(`Choose where you will collect your order — ${biz.businessName} has ${pickPts.length} pickup points.`);
    if (fulfillment === "DELIVERY" && !deliveryPin)
      return setOrderError(
        "Pin your exact delivery point on the Google Map below — tap “Use my location” (or drop the pin and fine-tune it with the arrows) so our courier finds you without calling.",
      );
    // Guard: a pin left exactly at the SHOP's own coordinates (e.g. the
    // customer tapped "Drop pin at map centre" without moving it) would send
    // the courier back to the shop instead of the customer — block it.
    if (fulfillment === "DELIVERY" && deliveryPin && pinAtShopM != null && pinAtShopM < 75)
      return setOrderError(
        "That delivery pin is still on the shop itself — nudge it with the arrows (or use “Use my location”) until it sits at YOUR doorstep, then place the order.",
      );
    setPlacing(true);
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: biz.businessId,
          customerName: name.trim(),
          customerPhone: phoneVerdict.value,
          fulfillmentType: fulfillment,
          destinationAddress: destination.trim(),
          ...(fulfillment === "PICKUP" && pickPointId ? { pickupLocationId: pickPointId } : {}),
          ...(fulfillment === "DELIVERY" && deliveryPin
            ? {
                deliveryLat: deliveryPin.lat,
                deliveryLng: deliveryPin.lng,
                deliveryAccuracyM: deliveryPin.accuracyM ?? undefined,
              }
            : {}),
          paymentChoice: payChoice,
          momoRef: momoRef.trim(),
          note: note.trim(),
          items: cart.map((l) => ({ inventoryId: l.product.id, quantity: l.qty })),
        }),
      });
      const data = await res.json();
      if (data?.success) {
        setPlaced(data.order);
        setCart([]);
      } else {
        setOrderError(data?.error || "Could not place your order. Please try again.");
      }
    } catch {
      setOrderError("Could not reach the store. Please try again.");
    } finally {
      setPlacing(false);
    }
  };

  // Whether any customer support information has been published yet.
  const supportHasInfo = !!support && ["contactName", "phone", "whatsapp", "email", "address", "openingHours", "extraInfo"]
    .some((k) => typeof support[k] === "string" && support[k].trim() !== "");
  const whatsappDigits = support?.whatsapp ? String(support.whatsapp).replace(/\D/g, "") : "";

  // One product card — Amazon-style: image, name, category, price,
  // availability and an always-one-tap Add / stepper.
  const renderProduct = (p: any, fromBiz?: any) => {
    const q = inCart(p.id);
    const photos = productPhotos(p);
    return (
      <div
        key={p.id}
        className="bg-white border border-slate-200 rounded-xl p-3 flex flex-col shadow-sm hover:shadow-md hover:border-amber-300 transition"
        data-testid={`oo-prod-${p.id}`}
      >
        {photos.length > 0 ? (
          <div className="mb-2.5">
            <button
              type="button"
              onClick={() => setLightbox({ p, fromBiz, idx: 0 })}
              className="relative w-full group cursor-zoom-in bg-white"
              title="Tap to enlarge"
              data-testid={`oo-photo-${p.id}`}
            >
              <img src={photos[0]} alt={p.name} className="w-full h-32 sm:h-36 object-contain rounded-lg transition group-hover:scale-[1.03]" />
              <span className="absolute bottom-1 right-1 p-1 rounded-md bg-black/50 text-white opacity-70 group-hover:opacity-100">
                <ZoomIn className="w-3 h-3" />
              </span>
            </button>
            {photos.length > 1 && (
              <div
                className="mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5"
                data-testid={`oo-thumbs-${p.id}`}
                aria-label={`${photos.length} photos of ${p.name}`}
              >
                {photos.map((ph, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setLightbox({ p, fromBiz, idx: i })}
                    className={`shrink-0 w-11 h-11 rounded-md border-2 overflow-hidden bg-white transition ${
                      i === 0 ? "border-amber-400" : "border-slate-200 hover:border-amber-300"
                    }`}
                    data-testid={`oo-thumb-${p.id}-${i}`}
                    aria-label={`View photo ${i + 1} of ${photos.length}`}
                  >
                    <img src={ph} alt={`${p.name} ${i + 1}`} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="w-full h-32 sm:h-36 rounded-lg mb-2.5 bg-slate-50 border border-slate-100 flex items-center justify-center">
            <PackageCheck className="w-8 h-8 text-slate-300" />
          </div>
        )}
        <div className="text-[13px] font-semibold text-slate-900 leading-snug line-clamp-2 flex-1">{p.name}</div>
        <div className="text-[10px] text-slate-500 mt-1">
          <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-bold text-slate-600">{p.category}</span>
          <span className="ml-1">per {p.unit}</span>
        </div>
        <div className="mt-1.5 flex items-end justify-between gap-1">
          <div className="text-[17px] font-black text-slate-900 leading-none">{fmtMoney(p.price)}</div>
        </div>
        <div className="mt-1" data-testid={`oo-avail-${p.id}`}>
          {p.available >= 10 ? (
            <span className="text-[11px] font-bold text-emerald-600">In stock</span>
          ) : p.available > 0 ? (
            <span className="text-[11px] font-bold text-amber-600">Only {p.available} {p.unit} left</span>
          ) : (
            <span className="text-[11px] font-bold text-rose-600">Out of stock</span>
          )}
        </div>
        {q === 0 ? (
          <button
            onClick={() => add(p, 1, fromBiz)}
            disabled={p.available <= 0}
            className="mt-2.5 w-full py-2 rounded-full bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-900 text-[12px] font-black flex items-center justify-center gap-1 shadow-sm transition"
            data-testid={`oo-add-${p.id}`}
          >
            <Plus className="w-3.5 h-3.5" /> Add to Cart
          </button>
        ) : (
          <div className="mt-2.5 flex items-center justify-between rounded-full border-2 border-amber-400 bg-amber-50 px-1.5 py-1">
            <button onClick={() => add(p, -1, fromBiz)} className="p-1 rounded-full hover:bg-amber-100 text-slate-700" data-testid={`oo-minus-${p.id}`}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <QtyInput value={q} max={p.available} onCommit={(v) => setQty(p, v, fromBiz)} testid={`oo-qty-${p.id}`} />
            <button onClick={() => add(p, 1, fromBiz)} disabled={q >= p.available} className="p-1 rounded-full hover:bg-amber-100 text-slate-700 disabled:opacity-30" data-testid={`oo-plus-${p.id}`}>
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const fieldCls =
    "w-full pl-8 pr-3 py-2.5 bg-slate-50 border border-slate-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-400 rounded-xl text-sm text-slate-900 placeholder-slate-400 outline-none";

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* ══ Amazon-style header: logo · search · HELP · track · cart ══ */}
      <header className="bg-[#131921] text-white sticky top-0 z-40 shadow-lg" data-testid="oo-header">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2.5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <a href="/order" className="flex items-center gap-2 shrink-0" data-testid="oo-logo">
            <span className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center font-black text-white text-sm shadow">
              360
            </span>
            <span className="leading-tight hidden xs:block sm:block">
              <span className="block text-sm font-black">GoMina 360</span>
              <span className="block text-[9px] text-emerald-300">Official store · live stock</span>
            </span>
          </a>
          <div className="order-3 sm:order-2 basis-full sm:basis-auto sm:flex-1 min-w-0">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={allMode ? "Search all products across every shop…" : `Search ${biz?.businessName || "this shop"}…`}
                className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm text-slate-900 bg-white outline-none border-2 border-transparent focus:border-amber-400 shadow-inner"
                data-testid="oo-search"
                aria-label="Search products"
              />
            </div>
          </div>
          <div className="order-2 sm:order-3 ml-auto flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[12px] font-black shadow transition"
              data-testid="oo-help"
              aria-label="Open help and customer support"
            >
              <LifeBuoy className="w-4 h-4" /> HELP
            </button>
            <a href="/track" className="px-2 py-2 text-[11px] font-bold text-cyan-300 hover:text-cyan-200" data-testid="oo-track-link">
              Track order →
            </a>
            <button
              type="button"
              onClick={() => {
                if (cart.length === 0) return;
                setCartOpen(true);
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
              }}
              className="relative flex items-center gap-1.5 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-white transition"
              data-testid="oo-header-cart"
              aria-label={`Cart with ${cartCount} items`}
            >
              <ShoppingCart className="w-5 h-5 text-amber-400" />
              <span className="text-[11px] font-black hidden sm:inline">Cart</span>
              <span
                className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center ${cartCount ? "bg-amber-400 text-slate-950" : "bg-slate-700 text-slate-300"}`}
                data-testid="oo-header-cart-count"
              >
                {cartCount}
              </span>
            </button>
          </div>
        </div>
        {/* Category nav bar (Amazon-style departments strip) */}
        {biz && (
          <div className="bg-[#232f3e] border-t border-slate-700/50">
            <div className="max-w-7xl mx-auto px-3 sm:px-4 py-1.5 flex gap-1.5 overflow-x-auto" data-testid="oo-catbar">
              {(allMode ? categoriesAllMode : categories).map((c) => (
                <button
                  key={c}
                  onClick={() => setCat(c)}
                  className={`shrink-0 px-3 py-1.5 rounded-md text-[11px] font-bold transition whitespace-nowrap ${
                    cat === c
                      ? "bg-amber-400 text-slate-950"
                      : "text-slate-200 hover:bg-slate-700/70 hover:text-white"
                  }`}
                  data-testid={`oo-cat-${c}`}
                >
                  {c === "ALL" ? "All departments" : c}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <main
        className={`max-w-7xl mx-auto px-3 sm:px-4 py-4 space-y-4 ${cart.length ? "pb-[26rem]" : "pb-24"}`}
        data-testid="oo-root"
      >
        {menuError && (
          <div className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs font-bold" data-testid="oo-menu-error">
            {menuError}
          </div>
        )}
        {!menu && !menuError && <p className="text-center text-slate-500 text-sm py-10">Loading the store…</p>}

        {menu && !placed && (
          <>
            {/* Welcome strip — where everything lives & how the flow works */}
            <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
              <h1 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Store className="w-4 h-4 text-emerald-600" /> Everything from all our businesses — live stock, one page
              </h1>
              <p className="text-[11px] text-slate-600 mt-1">
                Pick products, place your order, and get a <span className="font-mono font-bold text-cyan-700">GM-*</span> tracking
                code instantly. Follow every step — confirmation, preparation, dispatch with a live map, delivery —
                on the <a href="/track" className="text-cyan-700 font-bold underline">tracking page</a>. No account, ever.
                New here? Tap the <span className="font-black text-amber-700">HELP</span> button above for the 7-step guide,
                support contacts and opening hours.
              </p>
            </section>

            {/* Branches serving my location (Google Maps) */}
            <section className="bg-white border border-slate-200 rounded-2xl p-3.5 space-y-2 shadow-sm" data-testid="oo-serve-card">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[12px] font-extrabold text-slate-900 flex items-center gap-1.5 flex-1 min-w-[140px]">
                  <Globe className="w-4 h-4 text-emerald-600" /> Branches serving your location
                </h2>
                {!custLoc ? (
                  <>
                    <button
                      onClick={useMyLocation}
                      disabled={locBusy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-bold shadow-sm"
                      data-testid="oo-locate"
                    >
                      <Navigation className={`w-3.5 h-3.5 ${locBusy ? "animate-spin" : ""}`} />
                      {locBusy ? "Locating…" : "Use my location"}
                    </button>
                    <button
                      onClick={() => setLocPinOpen((o) => !o)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-[11px] font-bold"
                      data-testid="oo-locate-pin"
                    >
                      <MapPin className="w-3.5 h-3.5 text-cyan-600" /> Drop a pin
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setNearOnly(true)}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition ${
                        nearOnly
                          ? "bg-emerald-50 border-emerald-500 text-emerald-700"
                          : "bg-white border-slate-300 text-slate-500 hover:text-slate-800"
                      }`}
                      data-testid="oo-locate-nearonly"
                    >
                      Serving me ({servingCount})
                    </button>
                    <button
                      onClick={() => setNearOnly(false)}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition ${
                        !nearOnly
                          ? "bg-cyan-50 border-cyan-500 text-cyan-700"
                          : "bg-white border-slate-300 text-slate-500 hover:text-slate-800"
                      }`}
                      data-testid="oo-locate-showall"
                    >
                      All ({decorated.length})
                    </button>
                    <button
                      onClick={clearLoc}
                      className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-500 text-[10px] font-bold"
                      data-testid="oo-locate-clear"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
              {locErr && (
                <p className="text-[10px] font-bold text-amber-700" data-testid="oo-locate-error">{locErr}</p>
              )}
              {custLoc && (
                <p className="text-[10px] text-slate-600" data-testid="oo-locate-state">
                  <span className="text-emerald-700 font-bold">{custLoc.source === "GPS" ? "GPS fix" : "Pinned"}</span>{" "}
                  <span className="font-mono">{custLoc.lat.toFixed(5)}, {custLoc.lng.toFixed(5)}</span>
                  {custLoc.accuracyM ? ` · ±${Math.round(custLoc.accuracyM)} m` : ""} — showing{" "}
                  <span className="font-bold text-slate-900">{servingCount}</span> of {decorated.length} branches whose
                  delivery area covers you, with the distance to each.
                </p>
              )}
              {locPinOpen && !custLoc && (
                <LocationPinPicker
                  value={null}
                  onChange={(p) => {
                    if (p && typeof p !== "function") {
                      setCustLoc({ lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, source: "PIN" });
                      setNearOnly(true);
                      setLocPinOpen(false);
                      setLocErr("");
                    }
                  }}
                  defaultCenter={null}
                  prefix="oo-loc-pin"
                  hint="Drop the pin where you are — we show only the branches that deliver to that point."
                />
              )}
            </section>

            {/* Shop by store — business picker */}
            {visibleBiz.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-2xl p-5 text-center space-y-2 shadow-sm" data-testid="oo-no-biz">
                <p className="text-sm text-slate-700 font-bold">No branch currently delivers to this location.</p>
                <p className="text-[11px] text-slate-500">
                  You can still browse every branch and choose pickup — or try a different spot.
                </p>
                <button
                  onClick={() => setNearOnly(false)}
                  className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold"
                  data-testid="oo-no-biz-showall"
                >
                  Show all branches
                </button>
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1" data-testid="oo-bizrow">
                <button
                  onClick={pickAll}
                  className={`shrink-0 px-3 py-2 rounded-xl border text-left transition shadow-sm ${
                    allMode
                      ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400"
                      : "bg-white border-slate-200 hover:border-slate-400"
                  }`}
                  data-testid="oo-biz-all"
                >
                  <div className="text-[12px] font-extrabold whitespace-nowrap text-slate-900">🛍️ All businesses</div>
                  <div className="text-[9px] text-slate-500 whitespace-nowrap">
                    {allProductsCount} product{allProductsCount === 1 ? "" : "s"} · one page
                  </div>
                </button>
                {visibleBiz.map(({ b, serves, distanceM, areaName }) => (
                  <button
                    key={b.businessId}
                    onClick={() => pickBiz(b.businessId)}
                    className={`shrink-0 px-3 py-2 rounded-xl border text-left transition shadow-sm ${
                      bizId === b.businessId && !allMode
                        ? "bg-cyan-50 border-cyan-500 ring-1 ring-cyan-400"
                        : "bg-white border-slate-200 hover:border-slate-400"
                    }`}
                    data-testid={`oo-biz-${b.businessId}`}
                  >
                    <div className="text-[12px] font-extrabold whitespace-nowrap text-slate-900">{b.businessName}</div>
                    <div className="text-[9px] text-slate-500 whitespace-nowrap">
                      {b.branchName} · {b.products.length} product{b.products.length === 1 ? "" : "s"}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {serves && (b.serviceAreas || []).length > 0 && (
                        <span className="text-[9px] font-bold text-cyan-700 truncate max-w-[140px]" data-testid={`oo-biz-area-${b.businessId}`}>
                          {areaName || `${(b.serviceAreas || []).length} area${(b.serviceAreas || []).length === 1 ? "" : "s"}`}
                        </span>
                      )}
                      {distanceM != null && (
                        <span className="text-[9px] font-bold text-emerald-700" data-testid={`oo-biz-dist-${b.businessId}`}>
                          {(distanceM / 1000).toFixed(1)} km
                        </span>
                      )}
                      {!serves && (
                        <span className="text-[9px] font-bold text-amber-700" data-testid={`oo-biz-out-${b.businessId}`}>
                          pickup only here
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {biz?.serviceNote && (
              <p className="text-[10px] font-bold text-sky-700 px-1" data-testid="oo-biz-note">
                {biz.serviceNote}
              </p>
            )}
            {biz && (biz.serviceAreas || []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1 px-1" data-testid="oo-biz-areas">
                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Delivers to:</span>
                {biz.serviceAreas.map((a: any) => (
                  <span key={a.id} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-50 border border-sky-200 text-sky-700" data-testid={`oo-biz-areachip-${a.id}`}>
                    {a.name}{a.note ? ` · ${a.note}` : ""}
                  </span>
                ))}
              </div>
            )}

            {biz && (
              <>
                {/* Products — ALL businesses on one page (default), or the
                    focused business grouped by Product Category */}
                {allMode ? (
                  allGroups.length === 0 || allGroups.every((g) => g.count === 0) ? (
                    <p className="text-center text-slate-500 text-xs py-8" data-testid="oo-empty">No products match.</p>
                  ) : (
                    <div className="space-y-5" data-testid="oo-catalog">
                      {allGroups.map((g) => (
                        <section key={g.b.businessId} className="space-y-2.5" data-testid={`oo-bizsec-${g.b.businessId}`}>
                          <div className="flex items-center gap-2 flex-wrap rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                            <Store className="w-4 h-4 text-emerald-600 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <h3 className="text-[13px] font-black text-slate-900 leading-tight truncate">{g.b.businessName}</h3>
                              <p className="text-[10px] text-slate-500 leading-tight">
                                {g.b.branchName} · {g.count} product{g.count === 1 ? "" : "s"}
                              </p>
                            </div>
                            {g.distanceM != null && (
                              <span className="text-[9px] font-bold text-slate-500">
                                {g.distanceM < 1000 ? `${Math.round(g.distanceM)} m` : `${(g.distanceM / 1000).toFixed(1)} km`}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => pickBiz(g.b.businessId)}
                              className="shrink-0 px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-bold hover:text-cyan-700 hover:border-cyan-400"
                              data-testid={`oo-focus-${g.b.businessId}`}
                            >
                              Focus →
                            </button>
                          </div>
                          {g.secs.map((sec) => (
                            <section key={sec.name} className="space-y-2" data-testid={`oo-catsec-${g.b.businessId}-${sec.name}`}>
                              <div className="flex items-center gap-2 px-0.5">
                                <span className="w-1.5 h-6 rounded-full bg-gradient-to-b from-emerald-500 to-cyan-500" />
                                <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-800">{sec.name}</h3>
                                <span
                                  className="text-[10px] font-bold text-slate-500"
                                  data-testid={`oo-catsec-count-${g.b.businessId}-${sec.name}`}
                                >
                                  {sec.items.length} item{sec.items.length === 1 ? "" : "s"}
                                </span>
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                                {sec.items.map((pr) => renderProduct(pr, g.b))}
                              </div>
                            </section>
                          ))}
                        </section>
                      ))}
                    </div>
                  )
                ) : products.length === 0 ? (
                  <p className="text-center text-slate-500 text-xs py-8" data-testid="oo-empty">No products match.</p>
                ) : (
                  <div className="space-y-4" data-testid="oo-catalog">
                    {sections.map((sec) => (
                      <section key={sec.name} className="space-y-2" data-testid={`oo-catsec-${sec.name}`}>
                        <div className="flex items-center gap-2 px-0.5">
                          <span className="w-1.5 h-6 rounded-full bg-gradient-to-b from-emerald-500 to-cyan-500" />
                          <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-800">{sec.name}</h3>
                          <span
                            className="text-[10px] font-bold text-slate-500"
                            data-testid={`oo-catsec-count-${sec.name}`}
                          >
                            {sec.items.length} item{sec.items.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                          {sec.items.map((p) => renderProduct(p))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}

                {/* Checkout */}
                <section className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3 shadow-sm" data-testid="oo-checkout">
                  <h2 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-emerald-600" /> Checkout — your details
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="relative">
                      <UserIcon className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Your name"
                        className={fieldCls}
                        data-testid="oo-name"
                      />
                    </div>
                    <div className="relative">
                      <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={phone}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPhone(v);
                          // Live feedback the moment the customer types (or
                          // corrects) the number — cleared as soon as it is valid.
                          setPhoneErr(v.trim() ? validatePhone(v, { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT }).error : "");
                        }}
                        placeholder="Phone — exactly 10 digits (e.g. 0551234567)"
                        inputMode="tel"
                        className={`w-full pl-8 pr-3 py-2.5 bg-slate-50 border ${phoneErr ? "border-rose-400 focus:border-rose-500" : "border-slate-300 focus:border-amber-500"} rounded-xl text-sm text-slate-900 placeholder-slate-400 outline-none`}
                        data-testid="oo-phone"
                      />
                      {phoneErr && (
                        <p className="mt-1 text-[10px] font-bold text-rose-600" data-testid="oo-phone-error">{phoneErr}</p>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2" data-testid="oo-fulfillment">
                    <button
                      onClick={() => biz.pickupEnabled !== false && setFulfillment("PICKUP")}
                      disabled={biz.pickupEnabled === false}
                      className={`px-3 py-2.5 rounded-xl border text-left transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${fulfillment === "PICKUP" ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400" : "bg-white border-slate-300 hover:border-slate-400"}`}
                      data-testid="oo-pickup"
                    >
                      <PackageCheck className={`w-4 h-4 ${fulfillment === "PICKUP" ? "text-emerald-600" : "text-slate-400"}`} />
                      <div className="text-[12px] font-extrabold mt-1 text-slate-900">Pickup</div>
                      <div className="text-[9px] text-slate-500">
                        {biz.pickupEnabled === false ? "Not offered by this branch" : `Collect at ${biz.branchName}`}
                      </div>
                    </button>
                    <button
                      onClick={() => biz.deliveryEnabled !== false && setFulfillment("DELIVERY")}
                      disabled={biz.deliveryEnabled === false}
                      className={`px-3 py-2.5 rounded-xl border text-left transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${fulfillment === "DELIVERY" ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400" : "bg-white border-slate-300 hover:border-slate-400"}`}
                      data-testid="oo-delivery"
                    >
                      <Truck className={`w-4 h-4 ${fulfillment === "DELIVERY" ? "text-emerald-600" : "text-slate-400"}`} />
                      <div className="text-[12px] font-extrabold mt-1 text-slate-900">Delivery</div>
                      <div className="text-[9px] text-slate-500">
                        {biz.deliveryEnabled === false
                          ? "Not offered by this branch"
                          : biz.serviceRadiusKm != null
                          ? `Within ${biz.serviceRadiusKm} km · live courier map`
                          : "Track the courier live on the map"}
                      </div>
                    </button>
                  </div>
                  {fulfillment === "DELIVERY" && (
                    <div className="space-y-2" data-testid="oo-delivery-block">
                      <div className="relative">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          value={destination}
                          onChange={(e) => setDestination(e.target.value)}
                          placeholder="Delivery address (area / landmark / house no.)"
                          className={fieldCls}
                          data-testid="oo-destination"
                        />
                      </div>
                      <LocationPinPicker
                        value={deliveryPin}
                        onChange={setDeliveryPin}
                        defaultCenter={biz.gpsLat != null && biz.gpsLng != null ? { lat: biz.gpsLat, lng: biz.gpsLng } : null}
                        prefix="oo-pin"
                        hint="The courier navigates to this exact pin — only the branch team and the courier delivering your order can see it."
                      />
                      {deliveryPin && pinAtShopM != null && pinAtShopM < 75 && (
                        <p className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-1.5" data-testid="oo-pin-shop-warn">
                          ⚠ The pin is still at the shop's own location — move it to where YOU are (arrows / GPS / manual) so the courier comes to you, not back to the shop.
                        </p>
                      )}
                    </div>
                  )}
                  {fulfillment === "PICKUP" && (biz.pickupLocations || []).length > 0 && (
                    <div className="space-y-2" data-testid="oo-pickpoints">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                        <PackageCheck className="w-3.5 h-3.5 text-emerald-600" /> Choose your pickup point
                      </p>
                      {biz.pickupLocations.map((pt: any) => (
                        <label key={pt.id} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition ${pickPointId === pt.id ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400" : "bg-white border-slate-300 hover:border-slate-400"}`} data-testid={`oo-pickpoint-${pt.id}`}>
                          <input type="radio" className="mt-0.5" checked={pickPointId === pt.id} onChange={() => setPickPointId(pt.id)} />
                          <span className="min-w-0">
                            <span className="block text-[12px] font-extrabold text-slate-900">{pt.name}</span>
                            {pt.address && <span className="block text-[10px] text-slate-500">{pt.address}</span>}
                            {pt.instructions && <span className="block text-[9px] text-slate-400">{pt.instructions}</span>}
                          </span>
                        </label>
                      ))}
                      {chosenPickPoint && chosenPickPoint.lat != null && chosenPickPoint.lng != null && (
                        <div className="rounded-xl border border-slate-300 bg-slate-50 overflow-hidden" data-testid="oo-pickup-map">
                          <iframe
                            key={`${chosenPickPoint.lat},${chosenPickPoint.lng}`}
                            title={`Pickup point map — ${chosenPickPoint.name}`}
                            src={googleMapsEmbed(chosenPickPoint.lat, chosenPickPoint.lng, 16)}
                            className="w-full h-[180px] bg-slate-200"
                            loading="lazy"
                            referrerPolicy="no-referrer-when-downgrade"
                            data-testid="oo-pickup-map-frame"
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {fulfillment === "PICKUP" && (biz.pickupLocations || []).length === 0 && biz.gpsLat != null && biz.gpsLng != null && (
                    <div className="rounded-xl border border-slate-300 bg-slate-50 overflow-hidden" data-testid="oo-pickup-map">
                      <p className="px-3 pt-2.5 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-emerald-600" /> Pickup point — {biz.branchName}
                      </p>
                      <iframe
                        key={`${biz.gpsLat},${biz.gpsLng}`}
                        title="Branch pickup point — Google Maps"
                        src={googleMapsEmbed(biz.gpsLat, biz.gpsLng, 16)}
                        className="w-full h-[200px] bg-slate-200"
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        data-testid="oo-pickup-map-frame"
                      />
                      <p className="px-3 py-2 text-[10px] text-slate-500">
                        Collect your order here once it shows “Ready for Pickup” on the tracking page.
                      </p>
                    </div>
                  )}

                  <div className="space-y-1.5" data-testid="oo-payment">
                    <label className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition ${payChoice === "ON_DELIVERY" ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400" : "bg-white border-slate-300 hover:border-slate-400"}`} data-testid="oo-pay-ondelivery">
                      <input type="radio" className="mt-0.5" checked={payChoice === "ON_DELIVERY"} onChange={() => setPayChoice("ON_DELIVERY")} />
                      <span>
                        <span className="flex items-center gap-1.5 text-[12px] font-extrabold text-slate-900"><Banknote className="w-3.5 h-3.5 text-emerald-600" /> Pay on {fulfillment === "DELIVERY" ? "delivery" : "pickup"}</span>
                        <span className="block text-[9px] text-slate-500">Cash or MoMo when the order reaches you.</span>
                      </span>
                    </label>
                    <label className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition ${payChoice === "MOMO_NOW" ? "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400" : "bg-white border-slate-300 hover:border-slate-400"}`} data-testid="oo-pay-momo">
                      <input type="radio" className="mt-0.5" checked={payChoice === "MOMO_NOW"} onChange={() => setPayChoice("MOMO_NOW")} />
                      <span className="flex-1">
                        <span className="flex items-center gap-1.5 text-[12px] font-extrabold text-slate-900"><Smartphone className="w-3.5 h-3.5 text-amber-500" /> Pay now with MTN MoMo</span>
                        <span className="block text-[9px] text-slate-500">The branch shares the MoMo number and confirms your payment on your tracking page.</span>
                        {biz.momoNumber && (
                          <span className="block text-[10px] font-bold text-amber-700 mt-0.5" data-testid="oo-momo-dest">
                            Pay to: {biz.momoNumber}{biz.momoName ? ` — ${biz.momoName}` : ""}
                          </span>
                        )}
                      </span>
                    </label>
                    {payChoice === "MOMO_NOW" && (
                      <input
                        value={momoRef}
                        onChange={(e) => setMomoRef(e.target.value)}
                        placeholder="MoMo reference (optional, after you send)"
                        className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 focus:border-amber-500 rounded-xl text-sm text-slate-900 placeholder-slate-400 outline-none"
                        data-testid="oo-momo-ref"
                      />
                    )}
                  </div>

                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Any note for the staff? (optional)"
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 focus:border-amber-500 rounded-xl text-sm text-slate-900 placeholder-slate-400 outline-none"
                    data-testid="oo-note"
                  />

                  {orderError && (
                    <div className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs font-bold" data-testid="oo-error">
                      {orderError}
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}

        {/* Success */}
        {placed && (
          <section className="bg-white border border-emerald-300 rounded-2xl p-6 text-center space-y-3 shadow-sm" data-testid="oo-success">
            <PackageCheck className="w-12 h-12 text-emerald-500 mx-auto" />
            <h2 className="text-lg font-black text-slate-900">Order received — thank you, {placed.customerName}!</h2>
            <p className="text-[12px] text-slate-600">
              {placed.businessName}{placed.branchName ? ` (${placed.branchName})` : ""} has your order.
              Keep this tracking code safe — it is your only key to the order:
            </p>
            <div className="font-mono text-2xl font-black text-cyan-700 bg-cyan-50 border border-cyan-300 rounded-xl px-4 py-3" data-testid="oo-code">
              {placed.code}
            </div>
            <div className="text-[11px] text-slate-600">
              Total: <span className="font-black text-emerald-700">{fmtMoney(placed.totalGhs, placed.currency)}</span> ·{" "}
              {placed.fulfillmentType === "DELIVERY" ? "Delivery" : "Pickup"} ·{" "}
              {placed.payment === "PENDING_CONFIRMATION" ? "MoMo payment being confirmed" : "Pay on pickup/delivery"}
            </div>
            {placed.deliveryLocation && (
              <div className="rounded-xl border border-slate-300 overflow-hidden text-left" data-testid="oo-success-map">
                <p className="px-3 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-cyan-600" /> Your pinned delivery point
                </p>
                <iframe
                  key={`${placed.deliveryLocation.lat},${placed.deliveryLocation.lng}`}
                  title="Your pinned delivery point — Google Maps"
                  src={googleMapsEmbed(placed.deliveryLocation.lat, placed.deliveryLocation.lng, 17)}
                  className="w-full h-[180px] bg-slate-200"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  data-testid="oo-success-map-frame"
                />
                <p className="px-3 py-1.5 text-[10px] text-slate-500 font-mono">
                  {Number(placed.deliveryLocation.lat).toFixed(6)}, {Number(placed.deliveryLocation.lng).toFixed(6)}
                </p>
              </div>
            )}
            {placed.pickupLocation && (
              <div className="rounded-xl border border-slate-300 overflow-hidden text-left" data-testid="oo-success-pickup">
                <p className="px-3 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-emerald-600" /> Pickup point — {placed.branchName}
                </p>
                <iframe
                  key={`${placed.pickupLocation.lat},${placed.pickupLocation.lng}`}
                  title="Branch pickup point — Google Maps"
                  src={googleMapsEmbed(placed.pickupLocation.lat, placed.pickupLocation.lng, 16)}
                  className="w-full h-[180px] bg-slate-200"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            )}
            {placed.pickupLocation?.name && (
              <p className="text-[11px] text-emerald-700" data-testid="oo-success-pickpoint">
                Collect at: <span className="font-black">{placed.pickupLocation.name}</span>
                {placed.pickupLocation.address ? ` — ${placed.pickupLocation.address}` : ""}
              </p>
            )}
            {(placed.help || placed.momo) && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-left space-y-1" data-testid="oo-success-contacts">
                {placed.momo && (
                  <p className="text-[11px] text-amber-900" data-testid="oo-success-momo">
                    Pay MoMo to <span className="font-black">{placed.momo.number}</span>
                    {placed.momo.name ? ` (${placed.momo.name})` : ""} — keep your reference.
                  </p>
                )}
                {placed.help && (
                  <p className="text-[11px] text-amber-800" data-testid="oo-success-help">
                    Need help with this order? Call / WhatsApp <span className="font-black">{placed.help.phone}</span>
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-center gap-2 pt-1">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(placed.code);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 text-[11px] font-bold"
                data-testid="oo-copy"
              >
                <Copy className="w-3.5 h-3.5" /> {copied ? "Copied!" : "Copy code"}
              </button>
              <a
                href={`/track?code=${encodeURIComponent(placed.code)}`}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white text-[11px] font-bold"
                data-testid="oo-track-my-order"
              >
                Track my order live →
              </a>
            </div>
            <p className="text-[10px] text-slate-500 pt-1">
              The page refreshes automatically — you will see Confirmed → Processing → Ready/Dispatched → Delivered, payment status, and a live map when the courier is on the way.
            </p>
            <button onClick={() => setPlaced(null)} className="text-[11px] text-slate-500 underline hover:text-slate-700" data-testid="oo-new-order">
              Place another order
            </button>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 py-5 text-center space-y-1">
          <p className="text-[11px] text-slate-600">
            Need a hand? Tap the <button type="button" onClick={() => setHelpOpen(true)} className="font-black text-amber-700 underline" data-testid="oo-help-footer">HELP</button> button for support contacts, opening hours and the 7-step guide.
          </p>
          <p className="text-[10px] text-slate-400">GoMina 360 · Official customer storefront — no sign-in needed.</p>
        </div>
      </footer>

      {/* ══ HELP panel — support info + how-to (ONLY behind the HELP button) ══ */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
          data-testid="oo-help-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Help and customer support"
        >
          <div
            className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-5 py-4 bg-[#131921] text-white shrink-0">
              <span className="w-9 h-9 rounded-xl bg-amber-400 flex items-center justify-center shrink-0">
                <LifeBuoy className="w-5 h-5 text-slate-950" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-black leading-tight">Help &amp; Customer Support</h2>
                <p className="text-[10px] text-slate-300 leading-tight">Contacts · opening hours · how to order — all in one place.</p>
              </div>
              <button
                onClick={() => setHelpOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-300 hover:text-white shrink-0"
                data-testid="oo-help-close"
                aria-label="Close help"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-6">
              {/* Customer support information (edited by OWNER / granted staff) */}
              <section className="space-y-2.5" data-testid="oo-help-info">
                <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-emerald-600" /> Customer support
                </h3>
                {supportHasInfo ? (
                  <div className="space-y-2">
                    {support.contactName && (
                      <div className="flex items-start gap-2.5 text-[12px] text-slate-700" data-testid="oo-help-contact">
                        <span className="w-7 h-7 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
                          <UserIcon className="w-3.5 h-3.5 text-slate-600" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900">{support.contactName}</span><br />
                        <span className="text-[10px] text-slate-500">Your customer-care contact</span></span>
                      </div>
                    )}
                    {support.phone && (
                      <a href={`tel:${String(support.phone).replace(/\s+/g, "")}`} className="flex items-start gap-2.5 text-[12px] text-slate-700 hover:text-emerald-700" data-testid="oo-help-phone">
                        <span className="w-7 h-7 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
                          <Phone className="w-3.5 h-3.5 text-emerald-600" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900">{support.phone}</span><br />
                        <span className="text-[10px] text-slate-500">Tap to call us</span></span>
                      </a>
                    )}
                    {support.whatsapp && (
                      <a href={`https://wa.me/${whatsappDigits}`} target="_blank" rel="noreferrer" className="flex items-start gap-2.5 text-[12px] text-slate-700 hover:text-green-700" data-testid="oo-help-whatsapp">
                        <span className="w-7 h-7 rounded-lg bg-green-50 border border-green-200 flex items-center justify-center shrink-0">
                          <MessageCircle className="w-3.5 h-3.5 text-green-600" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900">{support.whatsapp}</span><br />
                        <span className="text-[10px] text-slate-500">Chat with us on WhatsApp</span></span>
                      </a>
                    )}
                    {support.email && (
                      <a href={`mailto:${support.email}`} className="flex items-start gap-2.5 text-[12px] text-slate-700 hover:text-sky-700" data-testid="oo-help-email">
                        <span className="w-7 h-7 rounded-lg bg-sky-50 border border-sky-200 flex items-center justify-center shrink-0">
                          <Mail className="w-3.5 h-3.5 text-sky-600" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900">{support.email}</span><br />
                        <span className="text-[10px] text-slate-500">Email us any time</span></span>
                      </a>
                    )}
                    {support.address && (
                      <div className="flex items-start gap-2.5 text-[12px] text-slate-700" data-testid="oo-help-address">
                        <span className="w-7 h-7 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-center shrink-0">
                          <MapPin className="w-3.5 h-3.5 text-rose-500" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900 whitespace-pre-line">{support.address}</span><br />
                        <span className="text-[10px] text-slate-500">Our business location</span></span>
                      </div>
                    )}
                    {support.openingHours && (
                      <div className="flex items-start gap-2.5 text-[12px] text-slate-700" data-testid="oo-help-hours">
                        <span className="w-7 h-7 rounded-lg bg-violet-50 border border-violet-200 flex items-center justify-center shrink-0">
                          <Clock className="w-3.5 h-3.5 text-violet-600" />
                        </span>
                        <span className="pt-1"><span className="font-bold text-slate-900">{support.openingHours}</span><br />
                        <span className="text-[10px] text-slate-500">Opening hours</span></span>
                      </div>
                    )}
                    {support.extraInfo && (
                      <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5" data-testid="oo-help-extra">
                        <p className="text-[10px] font-black uppercase tracking-wider text-amber-800 flex items-center gap-1">
                          <Info className="w-3.5 h-3.5" /> Good to know
                        </p>
                        <p className="text-[11px] text-amber-900 mt-0.5 whitespace-pre-line">{support.extraInfo}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5" data-testid="oo-help-empty">
                    Our support contacts are being set up — please check back soon. In the meantime you can follow any
                    order with its <span className="font-mono font-bold text-cyan-700">GM-…</span> code on the{" "}
                    <a href="/track" className="text-cyan-700 font-bold underline">tracking page</a>.
                  </p>
                )}
              </section>

              {/* How to use this order page — 7 quick steps */}
              <section data-testid="oo-howto">
                <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5 mb-2.5">
                  <Info className="w-3.5 h-3.5 text-cyan-600" /> How to use this order page — 7 quick steps
                </h3>
                <ol className="space-y-2" data-testid="oo-howto-steps">
                  {([
                    ["Everything on one page", <>Every product from <span className="font-bold text-emerald-700">all our businesses</span> sits on this ONE page — grouped by business, then category. Tap a store card (or a group's <span className="font-bold">Focus →</span>) to zoom into one shop, or tap <span className="font-bold text-emerald-700">Use my location</span> to sort branches by who delivers to you.</>],
                    ["Browse products by category", <>Products are grouped under their <span className="font-bold text-cyan-700">category sections</span>. Tap a department chip in the bar under the header to filter — or type in the search box to search every shop at once.</>],
                    ["Add to cart", <>Tap <span className="font-bold">Add to Cart</span>, then use <span className="font-bold">+ / −</span> or type the exact quantity into the number box. Your cart bar sits at the bottom of the screen — tap it any time to review or change items.</>],
                    ["Enter your details", <>Your name, and a phone number we can reach you on: <span className="font-bold text-cyan-700">exactly 10 digits</span>, like 0551234567 — no +233 country code.</>],
                    ["Pickup or delivery", <>Pickup: choose a pickup point. Delivery: describe your area, then <span className="font-bold text-rose-600">drag the map</span> so the red pin — it always stays at the centre of the map — sits exactly on your doorstep. Use +/− to zoom and the arrow pad for fine nudges, or tap <span className="font-bold text-cyan-700">Use my location</span> for GPS.</>],
                    ["Choose payment", <>Pay on delivery (cash/MoMo on arrival), or pay by MoMo now and paste the transaction reference. You can add a note for the branch too.</>],
                    ["Place order & track it", <>Tap <span className="font-bold text-emerald-700">Place order</span> — you instantly get a <span className="font-mono text-cyan-700">GM-…</span> code. Keep it, open <a href="/track" className="text-cyan-700 font-bold underline">Track order</a>, and follow confirmation, preparation, dispatch on a live map, and delivery.</>],
                  ] as [string, React.ReactNode][]).map(([title, body], i) => (
                    <li key={i} className="flex gap-2.5" data-testid={`oo-howto-step-${i + 1}`}>
                      <span className="shrink-0 w-5 h-5 rounded-full bg-cyan-50 border border-cyan-300 text-cyan-700 text-[10px] font-black flex items-center justify-center">{i + 1}</span>
                      <p className="text-[11px] text-slate-600 leading-relaxed"><span className="font-bold text-slate-900">{title}.</span> {body}</p>
                    </li>
                  ))}
                </ol>
              </section>
            </div>

            <div className="px-5 py-3 border-t border-slate-200 shrink-0">
              <button
                onClick={() => setHelpOpen(false)}
                className="w-full py-2.5 rounded-xl bg-[#131921] hover:bg-slate-800 text-white text-[12px] font-black transition"
                data-testid="oo-help-close-bottom"
              >
                Close — back to shopping
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product image lightbox — tap a product photo to enlarge it.
          Amazon-style gallery: main image, prev/next, thumbnails. */}
      {lightbox && (() => {
        const photos = productPhotos(lightbox.p);
        const count = photos.length;
        const idx = count > 0 ? Math.min(Math.max(lightbox.idx || 0, 0), count - 1) : 0;
        const showNav = count > 1;
        const go = (d: number) => {
          const next = (idx + d + count) % count;
          setLightbox({ ...lightbox, idx: next });
        };
        return (
          <div
            className="fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setLightbox(null)}
            data-testid="oo-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Enlarged photos of ${lightbox.p.name}`}
          >
            <div
              className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
                <div className="min-w-0">
                  <div className="text-sm font-extrabold text-slate-900 truncate">{lightbox.p.name}</div>
                  <div className="text-[10px] text-slate-500">
                    {lightbox.p.category} · {fmtMoney(lightbox.p.price)} / {lightbox.p.unit} · {lightbox.p.available} {lightbox.p.unit} left
                  </div>
                </div>
                <button
                  onClick={() => setLightbox(null)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-900 shrink-0"
                  data-testid="oo-lightbox-close"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="relative bg-white">
                {count > 0 ? (
                  <img
                    src={photos[idx]}
                    alt={`${lightbox.p.name} — photo ${idx + 1} of ${count}`}
                    className="w-full max-h-[52vh] object-contain bg-white"
                    data-testid="oo-lightbox-img"
                  />
                ) : (
                  <div className="w-full max-h-[52vh] aspect-square bg-slate-50 flex items-center justify-center">
                    <PackageCheck className="w-12 h-12 text-slate-300" />
                  </div>
                )}
                {showNav && (
                  <>
                    <button
                      type="button"
                      onClick={() => go(-1)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
                      data-testid="oo-lightbox-prev"
                      aria-label="Previous photo"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => go(1)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
                      data-testid="oo-lightbox-next"
                      aria-label="Next photo"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>
              {showNav && (
                <div className="px-4 py-2 flex items-center gap-2 border-t border-slate-100 overflow-x-auto">
                  {photos.map((ph, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setLightbox({ ...lightbox, idx: i })}
                      className={`shrink-0 w-12 h-12 rounded-md border-2 overflow-hidden bg-white transition ${
                        i === idx ? "border-amber-400" : "border-slate-200 hover:border-amber-300"
                      }`}
                      data-testid={`oo-lightbox-thumb-${i}`}
                      aria-label={`Photo ${i + 1} of ${count}`}
                      aria-current={i === idx}
                    >
                      <img src={ph} alt={`${lightbox.p.name} ${i + 1}`} className="w-full h-full object-cover" />
                    </button>
                  ))}
                  <span className="ml-auto text-[10px] font-bold text-slate-400 whitespace-nowrap" data-testid="oo-lightbox-count">
                    {idx + 1} / {count}
                  </span>
                </div>
              )}
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="text-lg font-black text-slate-900">{fmtMoney(lightbox.p.price)}</div>
                <button
                  onClick={() => {
                    add(lightbox.p, 1, lightbox.fromBiz);
                    setLightbox(null);
                  }}
                  disabled={lightbox.p.available <= 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-900 text-[12px] font-black"
                  data-testid="oo-lightbox-add"
                >
                  <Plus className="w-4 h-4" /> Add to Cart
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Cart bar */}
      {!placed && cart.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur shadow-[0_-6px_24px_rgba(2,6,23,0.12)]" data-testid="oo-cart">
          <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5">
            {cartOpen && (
              <div className="max-h-56 overflow-y-auto mb-2 divide-y divide-slate-100" data-testid="oo-cart-lines">
                {cart.map((l) => (
                  <div key={l.product.id} className="py-1.5 flex items-center gap-2 text-[12px]" data-testid={`oo-cart-line-${l.product.id}`}>
                    <span className="flex-1 min-w-0 truncate text-slate-700">{l.qty}× {l.product.name}</span>
                    <span className="text-slate-500">{fmtMoney(l.product.price * l.qty)}</span>
                    <button onClick={() => add(l.product, -l.qty)} className="p-1 text-slate-400 hover:text-rose-600" data-testid={`oo-cart-rm-${l.product.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => setCartOpen((o) => !o)} className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <ShoppingCart className="w-4 h-4 text-amber-500" />
                {cartCount} item{cartCount === 1 ? "" : "s"} {cartOpen ? "▾" : "▴"}
              </button>
              <button onClick={() => { setCart([]); }} className="text-[10px] text-slate-400 hover:text-rose-600 font-bold" data-testid="oo-clear">Clear</button>
              <span className="flex-1" />
              <span className="text-sm font-black text-slate-900" data-testid="oo-cart-total">{fmtMoney(cartTotal)}</span>
              <button
                onClick={placeOrder}
                disabled={placing}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-sm font-bold shadow-lg disabled:opacity-40"
                data-testid="oo-place"
              >
                {placing ? "Placing…" : "Place order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PublicOrderPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-100 text-slate-500 flex items-center justify-center text-sm">
          Loading the store…
        </div>
      }
    >
      <OrderInner />
    </Suspense>
  );
}
