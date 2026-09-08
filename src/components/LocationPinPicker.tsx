"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, MapPin, MapPinned, Minus, Plus, RotateCcw } from "lucide-react";
import { googleMapsEmbed, nudgeLatLng } from "@/lib/tracking";

export interface PinValue {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

/**
 * Google-Maps pin picker — lets a customer (or staff member) place the exact
 * delivery point without typing coordinates. The pin is fixed at the centre
 * of the map and the customer moves the MAP underneath it:
 *   1. “Use my current location” captures the device GPS position, or
 *      “Drop pin at the map centre” starts from the branch/area shown;
 *   2. DRAG the map (mouse or finger) to pan — on release, the new map
 *      centre becomes the saved pin; the +/− buttons zoom in/out;
 *   3. the arrow pad nudges the pin 1–500 m at a time for the exact spot —
 *      the embedded Google Map always re-centres on the pin.
 * Direct coordinate entry is also supported. No API key required.
 */
export default function LocationPinPicker({
  value,
  onChange,
  defaultCenter = { lat: 5.6037, lng: -0.187 }, // Accra fallback
  prefix = "pin",
  hint,
}: {
  value: PinValue | null;
  onChange: React.Dispatch<React.SetStateAction<PinValue | null>>;
  defaultCenter?: { lat: number; lng: number } | null;
  prefix?: string;
  hint?: string;
}) {
  const [step, setStep] = useState(5); // metres per arrow tap
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState("");
  const [manual, setManual] = useState(false);
  const [manLat, setManLat] = useState("");
  const [manLng, setManLng] = useState("");
  const pin = value;
  const center = defaultCenter || { lat: 5.6037, lng: -0.187 };
  const watchTried = useRef(false);
  // Map zoom (Google embed z param) — user-adjustable, auto close-up when a
  // pin first appears (mirrors the old "pin ? 18 : 13" behaviour).
  const [zoom, setZoom] = useState(13);
  const hadPin = useRef(false);
  // Drag-to-pan state: the pin is STRUCTURALLY at the map centre, so moving
  // the map = moving the saved coordinate.
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; base: { lat: number; lng: number }; moved: boolean } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const setPin = useCallback(
    (lat: number, lng: number, accuracyM: number | null = null) => {
      const latC = Math.max(-90, Math.min(90, lat));
      const lngC = Math.max(-180, Math.min(180, lng));
      onChange({ lat: latC, lng: lngC, accuracyM });
    },
    [onChange],
  );

  // Try GPS silently once on mount — if granted, the map starts exactly at
  // the customer; if denied/unavailable the nudge pad takes over.
  useEffect(() => {
    if (watchTried.current || pin || typeof navigator === "undefined" || !navigator.geolocation) return;
    watchTried.current = true;
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          onChange((prev: PinValue | null) => {
            // only auto-set when nothing was pinned meanwhile
            if (prev) return prev;
            return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null };
          });
        },
        () => {},
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
      );
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close-up view the moment a pin first appears (GPS, drop-pin, drag or
  // manual entry); afterwards the customer's own zoom choice is respected.
  useEffect(() => {
    if (pin && !hadPin.current) setZoom(18);
    hadPin.current = !!pin;
  }, [pin]);

  // ── Drag the map, pin stays at the centre ───────────────────────────────
  // The Google embed is key-less: customers used to pan the iframe itself and
  // the recorded coordinate never moved. Now a transparent drag surface sits
  // over the map: dragging slides the tiles live (CSS transform) and on
  // release the new MAP CENTRE becomes the pin — the marker overlay always
  // marks the exact centre, so the pin truly "stays at the centre".
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = { sx: e.clientX, sy: e.clientY, base: pin || center, moved: false };
    setDragging(true);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 3) return; // ignore taps / jitter
    d.moved = true;
    if (iframeRef.current) iframeRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    if (iframeRef.current) iframeRef.current.style.transform = "";
    if (!d.moved) return; // a plain click changes nothing
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    // Web-Mercator metres-per-pixel at the drag latitude and current zoom.
    const latRad = (d.base.lat * Math.PI) / 180;
    const mpp = (156543.03392 * Math.cos(latRad)) / Math.pow(2, zoom);
    // Dragging the tiles down/right pulls the viewport centre north/west.
    const newLat = d.base.lat + (dy * mpp) / 111320;
    const newLng = d.base.lng - (dx * mpp) / (111320 * Math.cos(latRad) || 1e-9);
    setPin(newLat, newLng, null);
  };

  const useGps = () => {
    setGeoMsg("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoMsg("This device cannot read GPS — drop the pin at the map centre and fine-tune it with the arrows.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPin(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? null);
        setGeoMsg("GPS position captured — nudge the pin if the dot is not exactly on your doorstep.");
      },
      () => {
        setLocating(false);
        setGeoMsg("Could not read your GPS (permission denied or no signal). You can still pin manually: drop the pin at the map centre, then fine-tune with the arrows.");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 },
    );
  };

  const nudge = (dNorth: number, dEast: number) => {
    const base = pin || center;
    const next = nudgeLatLng(base.lat, base.lng, dNorth * step, dEast * step);
    setPin(next.lat, next.lng, pin?.accuracyM ?? null);
  };

  const applyManual = () => {
    const lat = Number(manLat);
    const lng = Number(manLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setGeoMsg("Coordinates out of range — latitude −90…90, longitude −180…180.");
      return;
    }
    setPin(lat, lng, null);
    setGeoMsg("");
    setManual(false);
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 overflow-hidden" data-testid={`${prefix}-root`}>
      <div className="px-3 pt-2.5 pb-2 flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1 flex-wrap">
          <MapPinned className="w-3.5 h-3.5 text-cyan-300" /> Pin on Google Maps
          <span className="normal-case font-medium text-cyan-300/80">— drag the map; the pin stays at the centre</span>
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={useGps}
            disabled={locating}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold hover:bg-cyan-500/25 disabled:opacity-50"
            data-testid={`${prefix}-gps`}
          >
            <Crosshair className={`w-3 h-3 ${locating ? "animate-spin" : ""}`} />
            {locating ? "Locating…" : "Use my location"}
          </button>
          {pin ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-[10px] font-bold hover:text-rose-300"
              title="Remove the pin"
              data-testid={`${prefix}-clear`}
            >
              <RotateCcw className="w-3 h-3" /> Clear
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPin(center.lat, center.lng, null)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-bold hover:text-white"
              data-testid={`${prefix}-set`}
            >
              <MapPin className="w-3 h-3" /> Drop pin at map centre
            </button>
          )}
        </div>
      </div>

      {/* Live Google Map — drag the tiles; the pin never leaves the centre.
          A transparent surface intercepts drag gestures (the bare iframe used
          to pan itself and the saved coordinate never moved). */}
      <div className="relative overflow-hidden">
        <iframe
          ref={iframeRef}
          key={`${pin?.lat ?? center.lat},${pin?.lng ?? center.lng},${zoom}`}
          title="Delivery location — Google Maps"
          src={googleMapsEmbed(pin?.lat ?? center.lat, pin?.lng ?? center.lng, zoom)}
          className="w-full h-[220px] bg-slate-800"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          data-testid={`${prefix}-map`}
        />
        {/* Drag surface — pan the map with mouse or finger */}
        <div
          role="application"
          aria-label="Drag to move the map — the delivery pin stays at the centre"
          title="Drag to move the map — the delivery pin stays at the centre"
          className={`absolute inset-0 z-10 select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ touchAction: "none" }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          data-testid={`${prefix}-drag`}
        />
        {/* Exact pin overlay — fixed at the map centre; whatever the customer
            drags under it becomes the saved coordinate. */}
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="-translate-y-3">
            <MapPin
              className={`w-6 h-6 drop-shadow ${pin ? "text-rose-500 fill-rose-200" : "text-slate-500 fill-slate-300/50"}`}
              data-testid={`${prefix}-marker`}
            />
          </div>
        </div>
        {/* Zoom controls — re-frame around the same pin */}
        <div className="absolute right-2 top-2 z-30 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(20, z + 1))}
            disabled={zoom >= 20}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-900/90 border border-slate-600/70 text-white hover:bg-slate-800 disabled:opacity-40 shadow"
            title="Zoom in"
            data-testid={`${prefix}-zoom-in`}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(10, z - 1))}
            disabled={zoom <= 10}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-900/90 border border-slate-600/70 text-white hover:bg-slate-800 disabled:opacity-40 shadow"
            title="Zoom out"
            data-testid={`${prefix}-zoom-out`}
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Nudge pad — adjust the pin to the exact point */}
      <div className="px-3 py-2.5 border-t border-slate-800">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Adjust pin</span>
          <div className="flex items-center gap-1" data-testid={`${prefix}-nudge`}>
            <button type="button" onClick={() => nudge(1, 0)} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-bold hover:bg-slate-700" title="Move pin north" data-testid={`${prefix}-n`}>↑</button>
            <button type="button" onClick={() => nudge(-1, 0)} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-bold hover:bg-slate-700" title="Move pin south" data-testid={`${prefix}-s`}>↓</button>
            <button type="button" onClick={() => nudge(0, -1)} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-bold hover:bg-slate-700" title="Move pin west" data-testid={`${prefix}-w`}>←</button>
            <button type="button" onClick={() => nudge(0, 1)} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-bold hover:bg-slate-700" title="Move pin east" data-testid={`${prefix}-e`}>→</button>
          </div>
          <select
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-1.5 py-1 text-[10px] text-slate-300"
            title="Metres moved per arrow tap"
            data-testid={`${prefix}-step`}
          >
            <option value={1}>1 m steps</option>
            <option value={5}>5 m steps</option>
            <option value={25}>25 m steps</option>
            <option value={100}>100 m steps</option>
            <option value={500}>500 m steps</option>
          </select>
          <button
            type="button"
            onClick={() => { setManual((m) => !m); setManLat(pin ? String(pin.lat.toFixed(6)) : ""); setManLng(pin ? String(pin.lng.toFixed(6)) : ""); }}
            className="ml-auto text-[10px] font-bold text-cyan-300 hover:text-cyan-200 underline decoration-cyan-500/40"
            data-testid={`${prefix}-manual-toggle`}
          >
            {manual ? "Hide coordinates" : "Enter coordinates"}
          </button>
        </div>
        {manual && (
          <div className="mt-2 flex items-center gap-1.5" data-testid={`${prefix}-manual`}>
            <input
              value={manLat}
              onChange={(e) => setManLat(e.target.value)}
              placeholder="Latitude e.g. 5.6037"
              inputMode="decimal"
              className="flex-1 min-w-0 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-[11px] text-white outline-none focus:border-cyan-500/60"
              data-testid={`${prefix}-manual-lat`}
            />
            <input
              value={manLng}
              onChange={(e) => setManLng(e.target.value)}
              placeholder="Longitude e.g. -0.1870"
              inputMode="decimal"
              className="flex-1 min-w-0 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-[11px] text-white outline-none focus:border-cyan-500/60"
              data-testid={`${prefix}-manual-lng`}
            />
            <button
              type="button"
              onClick={applyManual}
              className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
              data-testid={`${prefix}-manual-apply`}
            >
              Set
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-cyan-300/90" data-testid={`${prefix}-coords`}>
            {pin ? `${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}` : "No pin yet — use GPS or drop a pin"}
          </span>
          {pin?.accuracyM != null && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400" data-testid={`${prefix}-accuracy`}>
              GPS ±{Math.round(pin.accuracyM)} m
            </span>
          )}
        </div>
        {hint && <p className="mt-1 text-[10px] text-slate-500">{hint}</p>}
        {geoMsg && <p className="mt-1 text-[10px] text-amber-300/90" data-testid={`${prefix}-geomsg`}>{geoMsg}</p>}
      </div>
    </div>
  );
}
