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

/** STANDARD road-map failover chain, in preference order. */
export const STANDARD_LAYERS: readonly TileLayerDef[] = [
  {
    // CARTO Voyager — clean Google-Maps-style standard road map; CORS-open,
    // explicitly usable without an API key, much more tolerant of embedding
    // than the OSM community CDN (whose usage policy blocks some deployments).
    key: "carto-voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    subdomains: "abcd",
  },
  {
    key: "osm-standard",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  {
    key: "esri-street",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors",
    maxZoom: 19,
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
  attribution: "",
  maxZoom: 19,
};

declare global {
  interface Window {
    __gominaMaps?: {
      maps: Record<
        string,
        {
          active: string;
          url: string;
          control: string;
          errors: Record<string, number>;
          loadedAny: boolean;
          exhausted: boolean;
          stuckNotice: string | null;
        }
      >;
    };
  }
}

/** How many failures on the ACTIVE layer (with zero successes on it) trigger
 *  failover to the next provider. Low enough to recover fast on blocked CDNs,
 *  high enough to ignore isolated 404s at extreme zooms. */
export const LAYER_FAILOVER_THRESHOLD = 4;

function publish(lane: string, patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const root = (window.__gominaMaps ||= { maps: {} });
  const prev = root.maps[lane] || { errors: {} };
  root.maps[lane] = { ...prev, ...(patch as any) };
}

/**
 * Failover state machine for a DEF chain. Returns the active layer and the
 * Leaflet `eventHandlers` to bind to its TileLayer.
 *
 * `tileload` on the active layer: recovery signal — any prior accumulated
 * error state for THAT layer is forgiven (transient bursts must not cause a
 * permanent failover once the provider responds).
 * `tileerror` beyond the threshold with no successes: advance to the next
 * provider (the layer remounts via `key`) and record it.
 */
export function useLayerFailover(lane: string, layers: readonly TileLayerDef[]) {
  const [idx, setIdx] = useState(0);
  const successes = useRef<Record<string, number>>({});
  const errors = useRef<Record<string, number>>({});
  const layer = layers[Math.min(idx, layers.length - 1)];
  const exhausted = idx >= layers.length - 1 && (errors.current[layer.key] || 0) >= LAYER_FAILOVER_THRESHOLD && !successes.current[layer.key];

  // Record the initially-declared layer immediately so a probe can locate the
  // map's diagnostics FINDABLY without waiting for the first tile outcome.
  useEffect(() => {
    publish(lane, {
      active: layer.key,
      url: layer.url,
      control: "leaflet-tilelayer",
      errors: { ...errors.current },
      loadedAny: Object.values(successes.current).some((n) => n > 0),
      exhausted: false,
      stuckNotice: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, layer.key, layer.url]);

  useEffect(() => {
    if (exhausted) {
      publish(lane, {
        exhausted: true,
        stuckNotice: "tile network unreachable for every standard provider",
      });
    }
  }, [exhausted, lane]);

  const handlers = {
    tileerror: useCallback(() => {
      const k = layer.key;
      errors.current[k] = (errors.current[k] || 0) + 1;
      publish(lane, { errors: { ...errors.current } });
      if (
        (errors.current[k] || 0) >= LAYER_FAILOVER_THRESHOLD &&
        !(successes.current[k] > 0) &&
        idx < layers.length - 1
      ) {
        setIdx(idx + 1);
      }
    }, [idx, layers.length, lane, layer.key]),
    tileload: useCallback(() => {
      const k = layer.key;
      successes.current[k] = (successes.current[k] || 0) + 1;
      // A loading provider must not be remembered as failing: reset its error
      // count so a later transient burst doesn't piggyback on stale history.
      errors.current[k] = 0;
      publish(lane, {
        errors: { ...errors.current },
        loadedAny: true,
        exhausted: false,
        stuckNotice: null,
      });
    }, [lane, layer.key]),
  } as const;

  return { layer, handlers, exhausted };
}
