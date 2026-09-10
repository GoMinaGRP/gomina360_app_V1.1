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

  // Sandbox / offline fallback — when neither Nominatim nor Photon is
  // reachable (common in dev/CI environments without outbound network),
  // still return deterministic matches against a small curated gazetteer so
  // the UI dropdown works for demo/testing. This matches by substring on
  // the query and biases towards the provided ll like the live upstream
  // does. Production deployments with real outbound network will hit the
  // real APIs before this fallback fires.
  if (!upstreamOk || results.length === 0) {
    const lowerQ = q.toLowerCase();
    const llParts = (ll || "").split(",").map(Number);
    const blat = llParts[0];
    const blng = llParts[1];
    const biasLat = Number.isFinite(blat) ? blat : 5.6037;
    const biasLng = Number.isFinite(blng) ? blng : -0.187;
    const fallback: (Suggestion & { keys?: string[] })[] = [
      { place_id: "fb-1", label: "Makola Market, Accra, Greater Accra, Ghana", lat: 5.5489, lng: -0.2094, keys: ["makola", "market", "accra", "central"] },
      { place_id: "fb-2", label: "Accra Central, Accra, Greater Accra, Ghana", lat: 5.556, lng: -0.203, keys: ["accra", "central"] },
      { place_id: "fb-3", label: "Osu Oxford Street, Osu, Accra, Ghana", lat: 5.565, lng: -0.182, keys: ["osu", "oxford"] },
      { place_id: "fb-4", label: "East Legon, Accra, Greater Accra, Ghana", lat: 5.638, lng: -0.163, keys: ["east legon", "legon"] },
      { place_id: "fb-5", label: "Airport Residential Area, Accra, Ghana", lat: 5.596, lng: -0.176, keys: ["airport", "residential"] },
      { place_id: "fb-6", label: "Spintex Road, Accra, Greater Accra, Ghana", lat: 5.632, lng: -0.095, keys: ["spintex"] },
      { place_id: "fb-7", label: "Tema Community 1, Tema, Greater Accra, Ghana", lat: 5.670, lng: -0.020, keys: ["tema", "community"] },
      { place_id: "fb-8", label: "Adum, Kumasi, Ashanti, Ghana", lat: 6.692, lng: -1.622, keys: ["adum", "kumasi"] },
      { place_id: "fb-9", label: "Kumasi Central Market, Kumasi, Ghana", lat: 6.69, lng: -1.618, keys: ["kumasi", "market"] },
      { place_id: "fb-10", label: "Tamale Central, Tamale, Northern, Ghana", lat: 9.400, lng: -0.839, keys: ["tamale"] },
      { place_id: "fb-11", label: "Takoradi Market Circle, Takoradi, Ghana", lat: 4.900, lng: -1.775, keys: ["takoradi", "circle"] },
      { place_id: "fb-12", label: "Cape Coast Castle, Cape Coast, Ghana", lat: 5.106, lng: -1.246, keys: ["cape coast"] },
      { place_id: "fb-13", label: "Dansoman, Accra, Ghana", lat: 5.550, lng: -0.250, keys: ["dansoman"] },
      { place_id: "fb-14", label: "Kaneshie Market, Accra, Ghana", lat: 5.582, lng: -0.235, keys: ["kaneshie"] },
      { place_id: "fb-15", label: "Accra Mall, Accra, Ghana", lat: 5.622, lng: -0.173, keys: ["mall", "accra mall"] },
      { place_id: "fb-16", label: "Achimota, Accra, Ghana", lat: 5.622, lng: -0.228, keys: ["achimota"] },
      { place_id: "fb-17", label: "Lapaz, Accra, Ghana", lat: 5.605, lng: -0.243, keys: ["lapaz"] },
      { place_id: "fb-18", label: "Circle (Kwame Nkrumah Interchange), Accra, Ghana", lat: 5.575, lng: -0.212, keys: ["circle", "nkrumah", "interchange"] },
    ];
    // Tokenize the query so a phrase like "accra makola" matches any entry
    // whose keys/label contain ANY of the tokens (AND: must match all
    // non-trivial tokens, but single-word queries match immediately).
    const tokens = lowerQ.split(/[\s,]+/).filter((t) => t.length >= 3);
    const scored = fallback
      .map((s) => {
        const hay = `${s.label.toLowerCase()} ${(s.keys || []).join(" ")}`;
        const hits = tokens.filter((t) => hay.includes(t)).length;
        if (hits < tokens.length) return null;
        return { ...s, _d: Math.hypot(s.lat - biasLat, s.lng - biasLng), _h: hits };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    scored.sort((a, b) => (b._h - a._h) || (a._d - b._d));
    const matches = scored.slice(0, 8).map(({ _d, _h, keys, ...rest }) => rest);
    if (matches.length > 0) results = matches;
  }

  cache.set(cacheKey, { at: Date.now(), results });
  if (cache.size > 200) {
    // cheap eviction: drop oldest
    const oldestKey = Array.from(cache.keys())[0];
    if (oldestKey) cache.delete(oldestKey);
  }

  return NextResponse.json({ results, degraded: !upstreamOk });
}
