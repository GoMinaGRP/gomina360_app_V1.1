"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, MapPin, MapPinned, Minus, Plus, RotateCcw, Satellite, Map as MapIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { nudgeLatLng } from "@/lib/tracking";

export interface PinValue {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export type TileStyle = "STANDARD" | "SATELLITE";

// Leaflet accesses `window` at module evaluation, so it cannot be imported
// from a module that Next.js also evaluates on the server. `ssr: false`
// guarantees the map only mounts in the browser.
const LeafletMap = dynamic(() => import("./LeafletPinMap"), {
  ssr: false,
  loading: () => (
    <div
      className="w-full flex items-center justify-center bg-slate-900 text-slate-400 text-[11px]"
      style={{ height: 260 }}
      data-testid="pin-map-loading"
    >
      <span className="flex items-center gap-2">
        <MapPin className="w-4 h-4 animate-pulse text-cyan-400" /> Loading interactive map…
      </span>
    </div>
  ),
});

/**
 * Customer-facing pin picker (Leaflet, no Google-Maps iframe required).
 * Tiles:
 *   • STANDARD  — OpenStreetMap (cartographic street map).
 *   • SATELLITE — Esri World Imagery + hybrid labels overlay so roads/places
 *                 still render on top of the photo.
 * UX matches the previous Google-Maps version: drag-to-pan (pin stays at
 * the centre), GPS locate, click-to-drop, arrow nudge pad, +/− zoom, direct
 * lat/lng entry. Both map instances on the order page share the same
 * tile-style state so the view toggle is consistent.
 */
export default function LocationPinPicker({
  value,
  onChange,
  defaultCenter = { lat: 5.6037, lng: -0.187 },
  prefix = "pin",
  hint,
  tileStyle: controlledStyle,
  onTileStyleChange,
}: {
  value: PinValue | null;
  onChange: React.Dispatch<React.SetStateAction<PinValue | null>>;
  defaultCenter?: { lat: number; lng: number } | null;
  prefix?: string;
  hint?: string;
  tileStyle?: TileStyle;
  onTileStyleChange?: (s: TileStyle) => void;
}) {
  const [step, setStep] = useState(5);
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState("");
  const [manual, setManual] = useState(false);
  const [manLat, setManLat] = useState("");
  const [manLng, setManLng] = useState("");
  const [internalStyle, setInternalStyle] = useState<TileStyle>("STANDARD");
  const style: TileStyle = controlledStyle ?? internalStyle;
  const setStyle = (s: TileStyle) => {
    setInternalStyle(s);
    onTileStyleChange?.(s);
  };
  const pin = value;
  const center = defaultCenter || { lat: 5.6037, lng: -0.187 };
  const [zoom, setZoom] = useState(13);
  const hadPin = useRef(false);
  const watchTried = useRef(false);

  const setPin = useCallback(
    (lat: number, lng: number, accuracyM: number | null = null) => {
      const latC = Math.max(-90, Math.min(90, lat));
      const lngC = Math.max(-180, Math.min(180, lng));
      onChange({ lat: latC, lng: lngC, accuracyM });
    },
    [onChange],
  );

  // One silent GPS attempt on mount.
  useEffect(() => {
    if (watchTried.current || pin || typeof navigator === "undefined" || !navigator.geolocation) return;
    watchTried.current = true;
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          onChange((prev: PinValue | null) => (prev ? prev : { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null }));
        },
        () => {},
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
      );
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pin && !hadPin.current) {
      hadPin.current = true;
      setZoom(18);
    }
  }, [pin]);

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
          <MapPinned className="w-3.5 h-3.5 text-cyan-300" /> Pin on the map
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

      <div className="relative overflow-hidden" style={{ height: 260 }}>
        <LeafletMap
          pin={pin}
          center={center}
          zoom={zoom}
          setZoom={setZoom}
          onCommit={(lat, lng) => setPin(lat, lng, null)}
          style={style}
          prefix={prefix}
        />

        {/* Map-style toggle pill */}
        <div className="absolute left-2 top-2 z-[1000] flex rounded-lg overflow-hidden border border-slate-600/70 bg-slate-900/90 shadow text-[10px] font-bold" data-testid={`${prefix}-style`}>
          <button
            type="button"
            onClick={() => setStyle("STANDARD")}
            className={`flex items-center gap-1 px-2 py-1 ${style === "STANDARD" ? "bg-cyan-500 text-slate-950" : "text-slate-200 hover:bg-slate-800"}`}
            title="Standard street map"
            data-testid={`${prefix}-style-std`}
          >
            <MapIcon className="w-3 h-3" /> Standard
          </button>
          <button
            type="button"
            onClick={() => setStyle("SATELLITE")}
            className={`flex items-center gap-1 px-2 py-1 ${style === "SATELLITE" ? "bg-cyan-500 text-slate-950" : "text-slate-200 hover:bg-slate-800"}`}
            title="Satellite / aerial view"
            data-testid={`${prefix}-style-sat`}
          >
            <Satellite className="w-3 h-3" /> Satellite
          </button>
        </div>

        {/* Zoom controls */}
        <div className="absolute right-2 top-2 z-[1000] flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(19, z + 1))}
            disabled={zoom >= 19}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-900/90 border border-slate-600/70 text-white hover:bg-slate-800 disabled:opacity-40 shadow"
            title="Zoom in"
            data-testid={`${prefix}-zoom-in`}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(3, z - 1))}
            disabled={zoom <= 3}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-900/90 border border-slate-600/70 text-white hover:bg-slate-800 disabled:opacity-40 shadow"
            title="Zoom out"
            data-testid={`${prefix}-zoom-out`}
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
      </div>

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
