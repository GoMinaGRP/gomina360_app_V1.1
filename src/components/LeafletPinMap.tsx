"use client";

// Leaflet map implementation — loaded client-only via next/dynamic so it
// never touches `window` during server render.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PinValue, TileStyle } from "./LocationPinPicker";

export default function LeafletPinMap({
  pin,
  center,
  zoom,
  setZoom,
  onCommit,
  style,
  prefix,
}: {
  pin: PinValue | null;
  center: { lat: number; lng: number };
  zoom: number;
  setZoom: (z: number | ((z: number) => number)) => void;
  onCommit: (lat: number, lng: number) => void;
  style: TileStyle;
  prefix: string;
}) {
  const initialCenter: [number, number] = useMemo(
    () => [pin?.lat ?? center.lat, pin?.lng ?? center.lng],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pinIcon = useMemo(
    () =>
      L.divIcon({
        className: "gomina-pin-icon",
        html: `<div style="transform:translate(-50%,-100%);filter:drop-shadow(0 2px 2px rgba(0,0,0,.4));">
                 <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
                      fill="${pin ? "#f43f5e" : "#64748b"}" stroke="white" stroke-width="1.5" stroke-linejoin="round">
                   <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>
                   <circle cx="12" cy="10" r="3" fill="white"/>
                 </svg></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      }),
    [pin],
  );

  return (
    <MapContainer
      center={initialCenter}
      zoom={zoom}
      zoomControl={false}
      scrollWheelZoom
      style={{ width: "100%", height: "100%", background: "#0f172a" }}
      data-testid={`${prefix}-map`}
    >
      <MapInternals
        pin={pin}
        onCommit={onCommit}
        zoom={zoom}
        setZoom={setZoom}
        style={style}
      />

      {style === "STANDARD" ? (
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
      ) : (
        <>
          {/* Esri World Imagery — base satellite/aerial photo layer. */}
          <TileLayer
            attribution="Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={19}
          />
          {/* Hybrid place/boundary labels so the satellite view isn't just
              an unlabelled photograph (fixes the old "Satellite doesn't work"
              behaviour where roads were invisible on the image). */}
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            maxZoom={19}
          />
        </>
      )}

      <CentreMarker icon={pinIcon} />
    </MapContainer>
  );
}

function CentreMarker({ icon }: { icon: L.DivIcon }) {
  const map = useMap();
  const [pos, setPos] = useState<[number, number]>([map.getCenter().lat, map.getCenter().lng]);
  useEffect(() => {
    const onMove = () => setPos([map.getCenter().lat, map.getCenter().lng]);
    map.on("move", onMove);
    return () => { map.off("move", onMove); };
  }, [map]);
  return <Marker position={pos} icon={icon} interactive={false} />;
}

function MapInternals({
  pin,
  onCommit,
  zoom,
  setZoom,
  style,
}: {
  pin: PinValue | null;
  onCommit: (lat: number, lng: number) => void;
  zoom: number;
  setZoom: (z: number | ((z: number) => number)) => void;
  style: TileStyle;
}) {
  const map = useMap();
  const suppressRef = useRef(false);

  useMapEvents({
    zoom: () => setZoom(map.getZoom()),
    moveend: () => {
      if (suppressRef.current) { suppressRef.current = false; return; }
      const c = map.getCenter();
      onCommit(c.lat, c.lng);
    },
    click: (e) => {
      suppressRef.current = true;
      onCommit(e.latlng.lat, e.latlng.lng);
    },
  });

  // Fly to pin whenever it changes externally (GPS, nudge, manual, autocomplete).
  useEffect(() => {
    if (!pin) return;
    const cur = map.getCenter();
    const dist = Math.hypot(cur.lat - pin.lat, cur.lng - pin.lng);
    if (dist < 1e-7) return;
    suppressRef.current = true;
    map.flyTo([pin.lat, pin.lng], map.getZoom(), { animate: true, duration: 0.35 });
  }, [pin?.lat, pin?.lng, map]);

  useEffect(() => {
    if (Math.abs(map.getZoom() - zoom) > 0.01) {
      suppressRef.current = true;
      map.setZoom(zoom);
    }
  }, [zoom, map]);

  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [style, map]);

  return null;
}
