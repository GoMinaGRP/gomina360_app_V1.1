"use client";

/**
 * Central map-layer catalogue + failover for the GoMina 360 maps.
 *
 * The "Standard" road view was a single hard-coded OpenStreetMap tile URL —
 * one CDN block / rate-limit / policy rejection on the customer's network and
 * the map went permanently dark (only the pin's divIcon still rendered on the
 * hard-coded dark background). The contract here:
 *
 *   • Standard tries providers in order and AUTOMATICALLY fails over to the
 *     next one when the active layer sustains errors with no successes.
 *   • Attribution always describes the ACTIVE provider (licence honesty).
 *   • Every mount publishes diagnostics to `window.__gominaMaps.maps` keyed by
 *     an audit lane: active provider key, url class, control, the per-provider
 *     error counts, and whether any tile ever loaded. Nothing about the layer
 *     is inferred from imagery — the declared active layer IS the truth and
 *     may never contradict the pin/overlay focus.
 *   • When every provider fails, `window.__gominaMaps.maps[lane].stuckNotice`
 *     is set and the caller renders the honest offline notice — the PIN IS
 *     THE PRODUCT and its exact coordinates + focus stay readable regardless.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface TileLayerDef {
  /** Stable provider key (used in diagnostics + attribution decisions). */
  key: string;
  url: string;
  /** Provider-required/appropriate attribution HTML for the ACTIVE layer. */
  attribution: string;
  maxZoom: number;
  /** Leaflet subdomains (if the scheme uses {s}). */
  subdomains?: string;
}

/** STANDARD road-map failover chain, in preference order (100% keyless & open).
 * Esri World Street Map is the primary standard basemap: commercial-grade, CORS-open,
 * keyless, reliable worldwide, and does not block web apps or preview domains with 403s.
 */
export const STANDARD_LAYERS: readonly TileLayerDef[] = [
  {
    // Esri World Street Map — high-resolution, commercial-grade street basemap.
    // CORS-open, zero API key required, highly detailed road/street labels worldwide.
    key: "esri-street",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri — Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, &copy; OpenStreetMap contributors",
    maxZoom: 19,
  },
  {
    // Esri World Topo Map — fallback topographic & road street basemap.
    key: "esri-topo",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri — Source: Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community",
    maxZoom: 19,
  },
  {
    // OpenStreetMap Standard (fallback).
    key: "osm-standard",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    subdomains: "abc",
  },
  {
    // Humanitarian OpenStreetMap (HOT) (fallback).
    key: "osm-hot",
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      'Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a> hosted by <a href="https://openstreetmap.fr/">OSM France</a>',
    maxZoom: 19,
    subdomains: "abc",
  },
] as const;

/** Satellite/hybrid chain (unchanged behaviour: imagery + label overlay). */
export const SATELLITE_BASE: TileLayerDef = {
  key: "esri-imagery",
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
  maxZoom: 19,
};
export const SATELLITE_LABELS: TileLayerDef = {
  key: "esri-hybrid-labels",
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri — Reference overlays",
  maxZoom: 19,
};

export type MapViewMode = "STANDARD" | "SATELLITE";

export interface UseMapLayerState {
  viewMode: MapViewMode;
  setViewMode: (mode: MapViewMode) => void;
  activeStandardIndex: number;
  activeDef: TileLayerDef;
  attribution: string;
  tileLoaded: boolean;
  allFailed: boolean;
  onTileLoad: () => void;
  onTileError: () => void;
  /** Reset failover state back to the preferred provider (e.g. after network recovered). */
  resetFailover: () => void;
}

/**
 * Manages provider failover and publishes per-map diagnostics to window.
 *
 * @param lane Diagnostic lane key under `window.__gominaMaps.maps[lane]`
 *             (e.g. "storefront", "track", "console", "pin-picker", "area-editor").
 */
export function useMapLayer(lane: string = "default"): UseMapLayerState {
  const [viewMode, setViewMode] = useState<MapViewMode>("STANDARD");
  const [stdIdx, setStdIdx] = useState<number>(0);
  const [tileLoaded, setTileLoaded] = useState<boolean>(false);
  const [allFailed, setAllFailed] = useState<boolean>(false);

  // Per-provider tracking: has this provider EVER loaded a tile in this session?
  // How many consecutive errors have occurred on the current provider?
  const errorsRef = useRef<Record<string, number>>({});
  const successRef = useRef<Record<string, boolean>>({});

  const activeDef: TileLayerDef =
    viewMode === "SATELLITE"
      ? SATELLITE_BASE
      : STANDARD_LAYERS[Math.min(stdIdx, STANDARD_LAYERS.length - 1)];

  // Publish live diagnostic state for the maps audit suite
  const publishDiag = useCallback(
    (opts?: { stuck?: boolean }) => {
      if (typeof window === "undefined") return;
      const g = ((window as any).__gominaMaps = (window as any).__gominaMaps || { maps: {}, errors: [] });
      g.maps = g.maps || {};
      const urlClass = activeDef.url.includes("server.arcgisonline.com")
        ? "esri"
        : activeDef.url.includes("openstreetmap")
        ? "osm"
        : "other";
      g.maps[lane] = {
        lane,
        viewMode,
        activeKey: activeDef.key,
        urlClass,
        activeUrl: activeDef.url,
        providerIndex: stdIdx,
        providerCount: STANDARD_LAYERS.length,
        tileLoaded,
        allFailed: opts?.stuck ?? allFailed,
        errors: { ...errorsRef.current },
        successes: { ...successRef.current },
        updatedAt: Date.now(),
      };
    },
    [activeDef, allFailed, lane, stdIdx, tileLoaded, viewMode],
  );

  // Update diagnostics whenever the active layer or mode changes
  useEffect(() => {
    publishDiag();
  }, [publishDiag]);

  const onTileLoad = useCallback(() => {
    successRef.current[activeDef.key] = true;
    setTileLoaded(true);
    setAllFailed(false);
    publishDiag({ stuck: false });
  }, [activeDef.key, publishDiag]);

  const onTileError = useCallback(() => {
    const k = activeDef.key;
    errorsRef.current[k] = (errorsRef.current[k] || 0) + 1;
    // Log once per provider into the global audit tray
    if (typeof window !== "undefined") {
      const g = ((window as any).__gominaMaps = (window as any).__gominaMaps || { maps: {}, errors: [] });
      g.errors = g.errors || [];
      if (!g.errors.some((e: any) => e.provider === k && e.lane === lane)) {
        g.errors.push({ lane, provider: k, url: activeDef.url, at: Date.now() });
      }
    }
    // Failover rule: if this provider has NEVER loaded a single tile and has
    // hit ≥ 2 tile errors, advance to the next provider in the chain.
    if (viewMode === "STANDARD" && !successRef.current[k] && errorsRef.current[k] >= 2) {
      if (stdIdx + 1 < STANDARD_LAYERS.length) {
        setStdIdx((i) => i + 1);
        setTileLoaded(false);
      } else {
        // Every provider has failed
        setAllFailed(true);
        publishDiag({ stuck: true });
      }
    } else {
      publishDiag();
    }
  }, [activeDef, lane, publishDiag, stdIdx, viewMode]);

  const resetFailover = useCallback(() => {
    errorsRef.current = {};
    successRef.current = {};
    setStdIdx(0);
    setTileLoaded(false);
    setAllFailed(false);
  }, []);

  return {
    viewMode,
    setViewMode,
    activeStandardIndex: stdIdx,
    activeDef,
    attribution: activeDef.attribution,
    tileLoaded,
    allFailed,
    onTileLoad,
    onTileError,
    resetFailover,
  };
}
