/**
 * Server-side geocoding proxy used by the customer order page's address
 * autocomplete. Runs the request through the server so (a) we ship a proper
 * User-Agent (Nominatim/OSM requires it and forbids browser-only traffic
 * without one), (b) we stay off the public CORS radar, and (c) every request
 * is debounced on the server via a tiny in-memory cache so repeated typing
 * never hammers the upstream.
 *
 * Returns a trimmed set of suggestions — display label, lat/lng, and
 * bounding box when available. The customer's current pin (if any) is passed
 * as `ll` so results bias toward the area they're already shopping from.
 */

import { NextResponse } from "next/server";

import { gazetteerSearch } from "@/lib/ghanaGazetteer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Suggestion = {
  place_id: number | string;
  label: string;
  lat: number;
  lng: number;
  bbox?: [number, number, number, number]; // [s, w, n, e]
};

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; results: Suggestion[] }>();

function clampSuggestion(raw: any): Suggestion | null {
  const lat = Number(raw.lat);
  const lng = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = String(raw.display_name || "").trim();
  if (!label) return null;
  let bbox: Suggestion["bbox"] | undefined;
  if (Array.isArray(raw.boundingbox) && raw.boundingbox.length >= 4) {
    const [s, n, w, e] = raw.boundingbox.map(Number);
    if ([s, n, w, e].every(Number.isFinite)) bbox = [s, w, n, e];
  }
  return {
    place_id: raw.place_id ?? `${lat},${lng}`,
    label,
    lat,
    lng,
    bbox,
  };
}

async function tryUpstream(url: string, signal: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "GoMina360/1.0 (+order address autocomplete)" },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const data = (await res.json()) as any[];
  const out: Suggestion[] = [];
  for (const r of data || []) {
    const s = clampSuggestion(r);
    if (s) out.push(s);
  }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const ll = String(url.searchParams.get("ll") || "").trim();
  if (q.length < 3) return NextResponse.json({ results: [] });

  const cacheKey = `${q}|${ll}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ results: hit.results });
  }

  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "1",
    limit: "8",
    "accept-language": "en",
  });
  // Bias results toward the customer's / branch's current pin when provided
  // (lat,lng — Amazon-style "near your delivery area" behaviour).
  if (ll) {
    const [lat, lng] = ll.split(",").map((v) => Number(v));
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      params.set("lat", String(lat));
      params.set("lon", String(lng));
      params.set("zoom", "14"); // street-level bias around the provided point
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let results: Suggestion[] = [];
  let upstreamOk = false;

  // Primary: OpenStreetMap Nominatim (free, no key, good global coverage).
  try {
    const r = await tryUpstream(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      controller.signal,
    );
    if (r && r.length > 0) {
      results = r;
      upstreamOk = true;
    }
  } catch {
    /* network / parse error → fall through */
  }

  // Fallback: Photon (Komoot) — also free, key-less, different data set so
  // that Nominatim hiccups don't leave the autocomplete empty.
  if (results.length === 0) {
    try {
      const photonParams = new URLSearchParams({ q, lang: "en", limit: "8" });
      if (ll) {
        const [lat, lng] = ll.split(",").map((v) => Number(v));
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          photonParams.set("lat", String(lat));
          photonParams.set("lon", String(lng));
          photonParams.set("zoom", "14");
        }
      }
      const res = await fetch(`https://photon.komoot.io/api/?${photonParams.toString()}`, {
        signal: controller.signal,
        headers: { "User-Agent": "GoMina360/1.0" },
      });
      if (res.ok) {
        const data = (await res.json()) as { features?: any[] };
        const mapped: Suggestion[] = [];
        for (const f of data.features || []) {
          const [lng, lat] = f.geometry?.coordinates || [];
          const props = f.properties || {};
          const parts = [
            props.name,
            props.street,
            props.housenumber ? `#${props.housenumber}` : null,
            props.city || props.town || props.village || props.district,
            props.state,
            props.country,
          ].filter(Boolean);
          const label = parts.join(", ");
          const s: Suggestion = {
            place_id: f.properties?.osm_id ?? `${lat},${lng}`,
            label,
            lat: Number(lat),
            lng: Number(lng),
            // Photon gives extent [minLon,minLat,maxLon,maxLat]; convert to
            // our [s,w,n,e] convention.
            bbox: Array.isArray(props.extent) && props.extent.length === 4
              ? [Number(props.extent[1]), Number(props.extent[0]), Number(props.extent[3]), Number(props.extent[2])]
              : undefined,
          };
          if (Number.isFinite(s.lat) && Number.isFinite(s.lng) && label) mapped.push(s);
        }
        results = mapped;
        upstreamOk = true;
      }
    } catch {
      /* fall through with whatever we have */
    }
  }

  clearTimeout(timer);

  // Offline / unreachable-upstream fallback — the curated Ghana gazetteer
  // (src/lib/ghanaGazetteer.ts: ~90 delivery areas, markets, landmarks and
  // every regional capital with town-centre coordinates). Without this the
  // Places selector silently returns {degraded:true, results:[]} whenever
  // the hosting network can't reach Nominatim/Photon, which customers read
  // as a broken address field. Gazetteer hits still drop the pin within
  // ~1 km of the chosen town/area, and the customer drags it to their
  // doorstep afterwards.
  let source: "upstream" | "gazetteer" = "upstream";
  if (results.length === 0) {
    const matches = gazetteerSearch(q, 8).map((g, i) => ({
      place_id: `gh-gaz-${i}-${g.lat.toFixed(4)},${g.lng.toFixed(4)}`,
      label: `${g.label}, Ghana`,
      lat: g.lat,
      lng: g.lng,
    }));
    if (matches.length > 0) {
      results = matches;
      source = "gazetteer";
    }
  }

  cache.set(cacheKey, { at: Date.now(), results });
  if (cache.size > 200) {
    // cheap eviction: drop oldest
    const oldestKey = Array.from(cache.keys())[0];
    if (oldestKey) cache.delete(oldestKey);
  }

  return NextResponse.json({
    results,
    // degraded = no upstream AND no local matches — the only genuinely dead
    // state; UI uses this to show a "geocoder unavailable" hint.
    degraded: !upstreamOk && results.length === 0,
    source: upstreamOk ? "upstream" : source,
  });
}
