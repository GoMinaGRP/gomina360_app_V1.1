"use client";

import React, { useEffect, useMemo } from "react";
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MiniMapProps } from "./MiniLeafletMap";
import { tileOfflineMessage, TILE_ERROR_THRESHOLD, useTileErrors } from "./tileHealth";

/** Recentre + re-measure whenever the coordinates change. */
function Recenter({ lat, lng, zoom }: { lat: number; lng: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom());
  }, [lat, lng, map]);
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [zoom, lat, lng, map]);
  return null;
}

export default function MiniLeafletMapInner({
  lat,
  lng,
  zoom = 16,
  height = 200,
  label,
  prefix,
  "data-testid": testId,
}: MiniMapProps) {
  const { failed, bind } = useTileErrors();
  const icon = useMemo(
    () =>
      L.divIcon({
        className: "gomina-pin-icon",
        html: `<div style="transform:translate(-50%,-100%);filter:drop-shadow(0 2px 2px rgba(0,0,0,.4));">
                 <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
                      fill="#e11d48" stroke="white" stroke-width="1.5" stroke-linejoin="round">
                   <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>
                   <circle cx="12" cy="10" r="3" fill="white"/>
                 </svg></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 26],
      }),
    [],
  );

  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-slate-200" style={{ height }} data-testid={testId || `${prefix}-minimap`}>
      <MapContainer
        center={[lat, lng]}
        zoom={zoom}
        zoomControl={false}
        scrollWheelZoom={false}
        dragging={false}
        touchZoom={false}
        doubleClickZoom={false}
        boxZoom={false}
        keyboard={false}
        aria-hidden="true"
        style={{ width: "100%", height: "100%", background: "#f1f5f9" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          eventHandlers={bind}
        />
        <Marker position={[lat, lng]} icon={icon} interactive={false} />
        <Recenter lat={lat} lng={lng} zoom={zoom} />
      </MapContainer>
      {label && (
        <div className="absolute left-1.5 bottom-1.5 z-[500] bg-white/90 border border-slate-200 rounded-lg px-2 py-0.5 text-[10px] font-bold text-slate-700 shadow-sm">
          {label}
        </div>
      )}
      {failed >= TILE_ERROR_THRESHOLD && (
        <div
          className="absolute inset-x-1.5 bottom-1.5 z-[500] bg-amber-50/95 border border-amber-300 rounded-lg px-2.5 py-1.5 text-[10px] font-bold text-amber-900"
          data-testid={`${prefix}-map-offline`}
        >
          {tileOfflineMessage()}
        </div>
      )}
    </div>
  );
}
