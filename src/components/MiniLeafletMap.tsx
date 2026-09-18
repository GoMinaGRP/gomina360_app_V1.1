"use client";

import React from "react";
import dynamic from "next/dynamic";

/**
 * Lightweight, read-only map viewer used wherever the order flow previously
 * embedded a Google-Maps IFRAME (branch location, pickup point, placed-order
 * confirmation). Google's keyless `?output=embed` endpoint is unreliable
 * inside iframes (region-dependent framing bans / consent interstitials →
 * the "blocked map" grey box), so these spots now render the same local
 * MapLibre-free Leaflet stack as the interactive pin pickers: standard
 * OpenStreetMap tiles with a rose pin. Dynamic-loaded (ssr:false) because
 * Leaflet touches `window` at import time.
 *
 * "Open in Google Maps" external links are kept alongside for navigation.
 */

export interface MiniMapProps {
  lat: number;
  lng: number;
  zoom?: number;
  height?: number;
  label?: string;
  prefix: string;
  "data-testid"?: string;
}

const MiniMapInner = dynamic(() => import("./MiniLeafletMapInner"), {
  ssr: false,
  loading: () => (
    <div
      className="w-full bg-slate-100 flex items-center justify-center text-[11px] text-slate-500"
      style={{ height: 200 }}
      data-testid="mini-map-loading"
    >
      Loading map…
    </div>
  ),
});

export default function MiniLeafletMap(props: MiniMapProps) {
  return <MiniMapInner {...props} />;
}
