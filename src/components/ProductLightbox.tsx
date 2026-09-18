"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import WatermarkOverlay from "./WatermarkOverlay";
import type { WatermarkSpec } from "@/lib/watermark";
import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Maximize2,
  Minimize2,
  PackageCheck,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";

/**
 * Amazon-inspired product lightbox (not a copy): main image, prev/next,
 * thumbnail strip, counter, add-to-cart — PLUS a full zoom engine:
 *   • zoom in/out buttons (+/−) and 1× reset;
 *   • mouse wheel zoom (cursor-centred);
 *   • double-click / double-tap toggles 1× ↔ 2.5×;
 *   • drag to pan while zoomed (mouse + touch pointer events);
 *   • true pinch-to-zoom on touch screens (two active pointers, tracked by
 *     Pointer Events so it works on Android + iOS Safari ≥ 13);
 *   • full-screen mode toggle (fills the viewport; desktop dialog remains
 *     available for quick viewing);
 *   • keyboard: ← → navigate, + − zoom, 0 reset, Esc close.
 *
 * Pure client component — no external dependency; all gesture state is
 * local and resets when the current photo changes.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export default function ProductLightbox({
  photos,
  idx,
  product,
  wmSpec,
  fromBiz,
  canAdd,
  onClose,
  onNavigate,
  onAdd,
  fmtMoney,
}: {
  photos: string[];
  idx: number;
  product: any;
  /** Owner-configured storefront watermark — rendered as display overlay
   *  above the image (never baked in; pointer-events none so pinch/drag/
   *  wheel gestures are never intercepted). */
  wmSpec?: WatermarkSpec | null;
  fromBiz: any;
  canAdd: boolean;
  onClose: () => void;
  onNavigate: (i: number) => void;
  onAdd: () => void;
  fmtMoney: (n: number) => string;
}) {
  const count = photos.length;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [full, setFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  const imgWrapRef = useRef<HTMLDivElement | null>(null);

  // Gesture state (refs — never re-rendered during a move).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    mode: "none" | "pan" | "pinch";
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    startDist: number;
    startZoom: number;
    moved: boolean;
  }>({ mode: "none", startX: 0, startY: 0, startPanX: 0, startPanY: 0, startDist: 0, startZoom: 1, moved: false });

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

  const resetView = useCallback(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }, []);

  // Zoom around a focal point inside the viewport (defaults to centre).
  const zoomTo = useCallback(
    (next: number, fx?: number, fy?: number) => {
      const z2 = clampZoom(next);
      setZoom((z1) => {
        if (z2 === z1) return z1;
        setPan((p) => {
          const el = imgWrapRef.current;
          if (!el) return z2 === 1 ? { x: 0, y: 0 } : p;
          const r = el.getBoundingClientRect();
          const cx = fx != null ? fx : r.left + r.width / 2;
          const cy = fy != null ? fy : r.top + r.height / 2;
          // focal point's offset from centre, expressed in pre-zoom coords
          const ox = cx - (r.left + r.width / 2) - p.x;
          const oy = cy - (r.top + r.height / 2) - p.y;
          const scaleDown = (z1 - z2) / z1; // how much the content shrinks under the focal point
          const np = {
            x: p.x + ox * (scaleDown > 0 ? (z2 / z1 - 1) : -(1 - z2 / z1)),
            y: p.y + oy * (scaleDown > 0 ? (z2 / z1 - 1) : -(1 - z2 / z1)),
          };
          return z2 === 1 ? { x: 0, y: 0 } : clampPan(np.x, np.y, z2, el);
        });
        return z2;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clampPan = (px: number, py: number, z: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const MaxX = (r.width * (z - 1)) / 2;
    const MaxY = (r.height * (z - 1)) / 2;
    return { x: Math.min(MaxX, Math.max(-MaxX, px)), y: Math.min(MaxY, Math.max(-MaxY, py)) };
  };

  const go = useCallback(
    (d: number) => {
      if (count === 0) return;
      onNavigate((idx + d + count) % count);
    },
    [count, idx, onNavigate],
  );

  // Reset zoom/pan whenever the photo changes.
  useEffect(() => {
    resetView();
  }, [idx, resetView]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "+" || e.key === "=") zoomTo(zoom + 0.5);
      else if (e.key === "-") zoomTo(zoom - 0.5);
      else if (e.key === "0") resetView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go, zoom, zoomTo, resetView]);

  // Wheel zoom (cursor-centred), non-passive to prevent page scroll behind.
  useEffect(() => {
    const el = imgWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      zoomTo(zoom * factor, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Interactive overlays (prev/next, zoom +/-) live INSIDE the viewport:
    // capturing their pointer would swallow their click — bail out so the
    // button behaves as a button everywhere on the page.
    if ((e.target as HTMLElement | null)?.closest?.("button")) return;
    imgWrapRef.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length === 1) {
      g.mode = "pan";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
    } else if (pts.length === 2) {
      g.mode = "pinch";
      g.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      g.startZoom = zoom;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
    }
    g.moved = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (g.mode === "pinch" && pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const scale = dist / g.startDist;
      const z2 = clampZoom(g.startZoom * scale);
      // Keep the pinch midpoint stable: pan by the midpoint delta too.
      const mid0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const el = imgWrapRef.current;
      setZoom(z2);
      if (el) setPan(clampPan(g.startPanX + (mid0.x - ((g as any).midX ?? mid0.x)), g.startPanY + (mid0.y - ((g as any).midY ?? mid0.y)), z2, el));
      (g as any).midX = mid0.x;
      (g as any).midY = mid0.y;
      g.moved = true;
      setDragging(true);
    } else if (g.mode === "pan" && (zoom > 1 || true)) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        g.moved = true;
        setDragging(true);
      }
      if (zoom > 1) {
        const el = imgWrapRef.current;
        if (el) setPan(clampPan(g.startPanX + dx, g.startPanY + dy, zoom, el));
      }
    }
  };

  const lastTap = useRef(0);
  // Timestamp of a touch double-tap the pointer layer handled — the browser
  // also synthesises a double-CLICK for the same gesture (esp. headless/CDP
  // dispatches); guard dblclick so the zoom doesn't toggle twice (reset then
  // re-zoom) for a single double-tap.
  const touchDblAt = useRef(0);
  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0) {
      // Double-TAP zoom toggle for touch devices (no dblclick is synthesised).
      if (e.pointerType === "touch" && g.mode === "pan" && !g.moved) {
        const now = Date.now();
        if (now - lastTap.current < 300) {
          zoomTo(zoom > 1.2 ? MIN_ZOOM : 2.5, e.clientX, e.clientY);
          touchDblAt.current = now;
          lastTap.current = 0;
        } else {
          lastTap.current = now;
        }
      }
      g.mode = "none";
      setDragging(false);
    } else if (pointers.current.size === 1 && g.mode === "pinch") {
      const [pt] = [...pointers.current.values()];
      g.mode = "pan";
      g.startX = pt.x;
      g.startY = pt.y;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
    }
  };

  // Double-tap for touch is handled in endPointer (no synthetic dblclick there);
  // desktop uses the native dblclick on the viewport below.

  const showNav = count > 1;

  return (
    <div
      className={`fixed inset-0 z-[70] bg-black/90 backdrop-blur-sm flex items-center justify-center ${full ? "p-0" : "p-3 sm:p-4"}`}
      onClick={() => onClose()}
      data-testid="oo-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Enlarged photos of ${product.name}`}
    >
      <div
        className={`bg-white border border-slate-200 shadow-2xl flex flex-col ${full ? "w-full h-full border-0" : "w-full max-w-lg rounded-2xl overflow-hidden max-h-[95vh]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-extrabold text-slate-900 truncate">{product.name}</div>
            <div className="text-[10px] text-slate-500">
              {product.category} · {fmtMoney(product.price)} / {product.unit} · {product.available} {product.unit} left
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setFull((f) => !f)}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-900"
              data-testid="oo-lightbox-full"
              aria-label={full ? "Exit full screen" : "Full screen"}
              title={full ? "Exit full screen" : "Full screen"}
            >
              {full ? <Minimize2 className="w-4.5 h-4.5" /> : <Maximize2 className="w-4.5 h-4.5" />}
            </button>
            <button
              onClick={() => onClose()}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-900"
              data-testid="oo-lightbox-close"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* image viewport — pan/pinch/zoom engine */}
        <div
          ref={imgWrapRef}
          className={`relative bg-white overflow-hidden select-none flex-1 ${full ? "" : "min-h-[240px]"} ${zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"}`}
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={(e) => {
            e.preventDefault();
            if (Date.now() - touchDblAt.current < 500) return; // touch double-tap already handled
            zoomTo(zoom > 1.2 ? MIN_ZOOM : 2.5, e.clientX, e.clientY);
          }}
          data-testid="oo-lightbox-viewport"
        >
          {count > 0 ? (
            <img
              src={photos[idx]}
              alt={`${product.name} — photo ${idx + 1} of ${count}`}
              draggable={false}
              className={`w-full object-contain bg-white pointer-events-none ${full ? "h-full" : "max-h-[52vh]"}`}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                transition: dragging ? "none" : "transform 120ms ease-out",
              }}
              data-testid="oo-lightbox-img"
              data-zoom={zoom}
            />
          ) : (
            <div className="w-full max-h-[52vh] aspect-square bg-slate-50 flex items-center justify-center">
              <PackageCheck className="w-12 h-12 text-slate-300" />
            </div>
          )}

          {/* Storefront watermark — viewport-anchored (NOT zoomed with the
              image) so it covers the visible frame in every zoom/pinch
              state; zero pointer interception. */}
          {count > 0 && <WatermarkOverlay spec={wmSpec} />}

          {showNav && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); go(-1); }}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
                data-testid="oo-lightbox-prev"
                aria-label="Previous photo"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); go(1) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
                data-testid="oo-lightbox-next"
                aria-label="Next photo"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}

          {/* zoom controls */}
          {count > 0 && (
            <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-white/90 border border-slate-200 rounded-full shadow px-1 py-0.5">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); zoomTo(zoom - 0.5); }}
                disabled={zoom <= MIN_ZOOM}
                className="w-7 h-7 rounded-full hover:bg-slate-100 disabled:opacity-30 flex items-center justify-center"
                data-testid="oo-lightbox-zoomout"
                aria-label="Zoom out"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="text-[10px] font-black text-slate-600 w-9 text-center" data-testid="oo-lightbox-zoomlvl">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); zoomTo(zoom + 0.5); }}
                disabled={zoom >= MAX_ZOOM}
                className="w-7 h-7 rounded-full hover:bg-slate-100 disabled:opacity-30 flex items-center justify-center"
                data-testid="oo-lightbox-zoomin"
                aria-label="Zoom in"
              >
                <Plus className="w-4 h-4" />
              </button>
              {zoom > MIN_ZOOM && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); resetView(); }}
                  className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center"
                  data-testid="oo-lightbox-zoomreset"
                  aria-label="Reset zoom"
                  title="Reset to fit"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* thumbnails */}
        {showNav && (
          <div className="px-4 py-2 flex items-center gap-2 border-t border-slate-100 overflow-x-auto shrink-0">
            {photos.map((ph, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onNavigate(i)}
                className={`relative shrink-0 w-12 h-12 rounded-md border-2 overflow-hidden bg-white transition ${
                  i === idx ? "border-amber-400" : "border-slate-200 hover:border-amber-300"
                }`}
                data-testid={`oo-lightbox-thumb-${i}`}
                aria-label={`Photo ${i + 1} of ${count}`}
                aria-current={i === idx}
              >
                <img src={ph} alt={`${product.name} ${i + 1}`} className="w-full h-full object-cover" />
                <WatermarkOverlay spec={wmSpec} compact />
              </button>
            ))}
            <span className="ml-auto text-[10px] font-bold text-slate-400 whitespace-nowrap" data-testid="oo-lightbox-count">
              {idx + 1} / {count}
            </span>
          </div>
        )}

        {/* Product details — registered ONCE in Inventory/Stock Entry and
            served verbatim via /api/menu. NO duplicate storefront entry:
            description, brand/model, size/weight specs, variants appear here
            automatically the moment the owner registers them. */}
        {(() => {
          const desc: string = (product.description || "").trim();
          const specs: { key: string; value: string }[] = Array.isArray(product.specifications) ? product.specifications : [];
          const variants: { name: string; note?: string }[] = Array.isArray(product.variants) ? product.variants : [];
          const brand: string = (product.brand || "").trim();
          const model: string = (product.model || "").trim();
          if (!desc && !brand && !model && specs.length === 0 && variants.length === 0) return null;
          return (
            <div className="px-4 py-2.5 border-t border-slate-100 shrink-0 max-h-44 overflow-y-auto" data-testid="oo-lightbox-details">
              {desc && (
                <p className="text-[12px] leading-snug text-slate-700 mb-2" data-testid="oo-lightbox-desc">{desc}</p>
              )}
              {(brand || model) && (
                <div className="flex flex-wrap gap-1.5 mb-2" data-testid="oo-lightbox-brand">
                  {brand && <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-700">{brand}</span>}
                  {model && <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-700">Model: {model}</span>}
                </div>
              )}
              {specs.length > 0 && (
                <dl className="mb-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5" data-testid="oo-lightbox-specs">
                  {specs.map((sp, i) => (
                    <div key={i} className="contents" data-testid={`oo-lightbox-spec-${i}`}>
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{sp.key}</dt>
                      <dd className="text-[11px] font-semibold text-slate-800">{sp.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {variants.length > 0 && (
                <div className="flex flex-wrap gap-1" data-testid="oo-lightbox-variants">
                  {variants.map((v, i) => (
                    <span key={i} data-testid={`oo-lightbox-variant-${i}`}
                      title={v.note || v.name}
                      className="px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-[9.5px] font-bold text-indigo-700">
                      {v.name}{v.note ? ` · ${v.note}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* footer */}
        <div className="px-4 py-3 flex items-center justify-between gap-3 border-t border-slate-100 shrink-0">
          <div className="text-lg font-black text-slate-900">{fmtMoney(product.price)}</div>
          <button
            onClick={onAdd}
            disabled={!canAdd}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-900 text-[12px] font-black"
            data-testid="oo-lightbox-add"
          >
            <Plus className="w-4 h-4" /> Add to Cart
          </button>
        </div>
      </div>
    </div>
  );
}
