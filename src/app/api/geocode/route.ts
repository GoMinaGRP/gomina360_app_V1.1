/**
 * Location search proxy for the customer order page — Google-Places-grade
 * granularity built on free upstreams (Nominatim + Photon), so it suggest
 * house/building addresses, streets, businesses/establishments, landmarks,
 * neighborhoods AND cities/towns — never restricted to cities/localities:
 *
 *   • Nominatim /search with addressdetails + extratags + namedetails and an
 *     UNBOUNDED viewbox around the customer's pin — the viewbox biases toward
 *     nearby Ghana results without hiding valid matches anywhere else.
 *   • Photon (different OSM POI set) as live failover.
 *   • Both feeds classify every hit into HOUSE | STREET | POI | LANDMARK |
 *     NEIGHBOURHOOD | CITY | AREA so the UI can show the right affordance and
 *     tests can prove granularity.
 *   • Distance re-rank: when a bias point (`ll`) is present, closer results
 *     earn a bounded bonus; faraway results lose nothing — only ordering.
 *   • Upstreams unreachable (host firewalls / sandbox): the curated typed
 *     Ghana gazetteer covers streets, hospitals, malls, campuses, markets
 *     and landmarks nationwide, so the selector never appears dead.
 *
 * Each suggestion carries the formatted label, upstream place_id, exact
 * lat/lng and a bbox — the client drops the pin at the exact point and keeps
 * the placeId so the order records the real Google-style place reference.
 */

import { throttle, clientIp } from "@/lib/rateLimit";
import { NextResponse } from "next/server";

import { gazetteerSearch, gazetteerType } from "@/lib/ghanaGazetteer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlaceType = "HOUSE" | "STREET" | "POI" | "LANDMARK" | "NEIGHBOURHOOD" | "CITY" | "AREA" | "OTHER";

type Suggestion = {
  place_id: number | string;
  label: string;
  lat: number;
  lng: number;
  type?: PlaceType;
  bbox?: [number, number, number, number]; // [s, w, n, e]
};

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; results: Suggestion[] }>();

/** Haversine kilometres. */
function distKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** OpenStreetMap/Nominatim class+type → granularity bucket. */
function classifyNominatim(spec: { class?: string; type?: string; addresstype?: string; address?: Record<string, string> }): PlaceType {
  const cls = String(spec.class || "");
  const typ = String(spec.type || spec.addresstype || "");
  const house = !!(spec.address && (spec.address.house_number || spec.address.house));
  if (house || cls === "building") return "HOUSE";
  switch (cls) {
    case "highway":
      return "STREET";
    case "amenity":
    case "shop":
    case "office":
    case "craft":
    case "healthcare":
      return "POI";
    case "tourism":
    case "historic":
    case "leisure":
    case "natural":
      return "LANDMARK";
    case "place":
      if (["suburb", "neighbourhood", "quarter", "township"].includes(typ)) return "NEIGHBOURHOOD";
      if (["city", "town", "village", "hamlet", "municipality", "city_block", "plot", "island", "islet", "locality"].includes(typ)) return "CITY";
      if (["administrative", "state", "region", "province", "county", "state_district"].includes(typ)) return "AREA";
      return "OTHER";
    case "boundary":
      return "AREA";
    default:
      return "OTHER";
  }
}

/** Photon properties → granularity bucket. */
function classifyPhoton(props: any): PlaceType {
  const key = String(props?.osm_key || "");
  if (props?.housenumber || props?.street && props?.name) {
    return key === "building" || props?.housenumber ? "HOUSE" : "STREET";
  }
  if (key) {
    if (key === "highway") return "STREET";
    if (["amenity", "shop", "office", "craft", "healthcare"].includes(key)) return "POI";
    if (["tourism", "historic", "leisure", "natural"].includes(key)) return "LANDMARK";
    if (key === "place") {
      const v = String(props?.osm_value || "");
      if (["suburb", "neighbourhood", "quarter", "township"].includes(v)) return "NEIGHBOURHOOD";
      if (["city", "town", "village", "hamlet"].includes(v)) return "CITY";
      return "AREA";
    }
  }
  return "OTHER";
}

function clampNominatim(raw: any): Suggestion | null {
  const lat = Number(raw.lat);
  const lng = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // formatted_address display_name is the Google-style full address.
  const label = String(raw.display_name || "").trim();
  if (!label) return null;
  let bbox: Suggestion["bbox"] | undefined;
  if (Array.isArray(raw.boundingbox) && raw.boundingbox.length >= 4) {
    const [south, north, west, east] = raw.boundingbox.map(Number);
    if ([south, north, west, east].every(Number.isFinite)) bbox = [south, west, north, east];
  }
  return {
    // Google-Places-style identifier (osm_type+osm_id survives dedupes).
    place_id: raw.osm_type && raw.osm_id ? `${raw.osm_type}${raw.osm_id}` : (raw.place_id ?? `${lat},${lng}`),
    label,
    lat,
    lng,
    type: classifyNominatim(raw),
    bbox,
  };
}

/**
 * Re-order a result list so nearby suggestions lead when a bias point is
 * supplied — but NO result is dropped or filtered, ever. The bonus decays
 * logarithmically (≈10 within the same city, ≈4 at 100 km, ≈2 at 1000 km),
 * bounded so a strong upstream-relevance rank can never be fully inverted by
 * a weak-but-in-town match.
 */
function nearbyRank(results: Suggestion[], lat: number | null, lng: number | null): Suggestion[] {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return results;
  return results
    .map((s, idx) => {
      const d = distKm(lat, lng, s.lat, s.lng);
      const bonus = Math.max(0, 12 - Math.log10(d + 1));
      return { s, score: (results.length - idx) * 6 + bonus };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/** Drop near-duplicate labels (same place from both upstreams). */
function dedupe(results: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return results.filter((s) => {
    const key = s.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET(req: Request) {
  // M7: IP-level throttle — geocoding proxies to upstream providers / cached
  // gazetteers; keep one host from hammering it.
  const limited = throttle(clientIp(req), { key: "geocode", limit: 120, windowMs: 60_000 });
  if (limited) return limited;
  const url = new URL(req.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const ll = String(url.searchParams.get("ll") || "").trim();
  if (q.length < 3) return NextResponse.json({ results: [] });

  const cacheKey = `v2|${q}|${ll}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ results: hit.results, cached: true });
  }

  let biasLat: number | null = null;
  let biasLng: number | null = null;
  if (ll) {
    const [a, b] = ll.split(",").map((v) => Number(v));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      biasLat = a;
      biasLng = b;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  let results: Suggestion[] = [];
  let upstreamOk = false;
  let source: "nominatim" | "photon" | "gazetteer" | "merged" = "nominatim";

  // ── Primary: Nominatim — global search with address + POI detail, biased
  //    (never bounded) to ±0.55° around the customer's pin. ───────────────
  const nomParams = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "1",
    extratags: "1",
    namedetails: "1",
    dedupe: "1",
    limit: "10",
    "accept-language": "en",
  });
  if (biasLat != null && biasLng != null) {
    // viewbox = soft geographic bias (bounded=0 deliberately ABSENT).
    const w = biasLng - 0.55;
    const sLat = biasLat - 0.55;
    const e = biasLng + 0.55;
    const n = biasLat + 0.55;
    nomParams.set("viewbox", `${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)},${sLat.toFixed(4)}`);
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${nomParams.toString()}`, {
      signal: controller.signal,
      headers: { "User-Agent": "GoMina360/1.0 (+order location search)" },
    });
    if (res.ok) {
      const data = (await res.json()) as any[];
      const out: Suggestion[] = [];
      for (const r of data || []) {
        const sug = clampNominatim(r);
        if (sug) out.push(sug);
      }
      if (out.length > 0) {
        results = out;
        upstreamOk = true;
      }
    }
  } catch {
    /* fall through to Photon */
  }

  // ── Failover: Photon (Komoot). ─────────────────────────────────────────
  if (results.length === 0) {
    try {
      const params = new URLSearchParams({ q, lang: "en", limit: "10" });
      if (biasLat != null && biasLng != null) {
        params.set("lat", String(biasLat));
        params.set("lon", String(biasLng));
        params.set("zoom", "14");
      }
      const res = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
        signal: controller.signal,
        headers: { "User-Agent": "GoMina360/1.0" },
      });
      if (res.ok) {
        const data = (await res.json()) as { features?: any[] };
        const out: Suggestion[] = [];
        for (const f of data.features || []) {
          const [lng, lat] = f.geometry?.coordinates || [];
          const props = f.properties || {};
          const parts = [
            props.name,
            props.housenumber ? `${props.street || ""} ${props.housenumber}`.trim() : (props.street || null),
            props.city || props.town || props.village || props.district,
            props.state,
            props.country,
          ].filter(Boolean);
          const label = parts.join(", ");
          const sug: Suggestion = {
            place_id: props.osm_id ? `${props.osm_type || "N"}${props.osm_id}` : `${lat},${lng}`,
            label,
            lat: Number(lat),
            lng: Number(lng),
            type: classifyPhoton(props),
            bbox: Array.isArray(props.extent) && props.extent.length === 4
              ? [Number(props.extent[1]), Number(props.extent[0]), Number(props.extent[3]), Number(props.extent[2])]
              : undefined,
          };
          if (Number.isFinite(sug.lat) && Number.isFinite(sug.lng) && label) out.push(sug);
        }
        if (out.length > 0) {
          results = out;
          upstreamOk = true;
          source = "photon";
        }
      }
    } catch {
      /* fall through to gazetteer */
    }
  }

  clearTimeout(timer);

  // ── Offline fallback: typed Ghana gazetteer. ───────────────────────────
  if (results.length === 0) {
    const gaz = gazetteerSearch(q, 10).map((g, i) => ({
      place_id: `gh-gaz-${i}-${g.lat.toFixed(4)},${g.lng.toFixed(4)}`,
      label:
        g.label.includes(", ") // already carries a city/region/country suffix — leave it alone
          ? (g.lat > 4.5 && g.lat < 11.3 && g.lng > -3.3 && g.lng < 1.3 && !g.label.includes(", Ghana")
              ? `${g.label}, Ghana`
              : g.label)
          : g.lat > 4.5 && g.lat < 11.3 && g.lng > -3.3 && g.lng < 1.3
            ? `${g.label}, Ghana`
            : g.label,
      lat: g.lat,
      lng: g.lng,
      type: gazetteerType(g),
    }));
    if (gaz.length > 0) {
      results = gaz;
      source = "gazetteer";
    }
  }

  // When an upstream answered but the gazetteer offers a nearer/different
  // hit for the same Ghana place, prepend its best single match (inside 25
  // km of the pin) so curated names surface quickly.
  if (upstreamOk && biasLat != null && biasLng != null) {
    const extra = gazetteerSearch(q, 3)
      .map((g, i) => ({
        place_id: `gh-gaz-${i}-${g.lat.toFixed(4)},${g.lng.toFixed(4)}`,
        label:
        g.label.includes(", ") // already carries a city/region/country suffix — leave it alone
          ? (g.lat > 4.5 && g.lat < 11.3 && g.lng > -3.3 && g.lng < 1.3 && !g.label.includes(", Ghana")
              ? `${g.label}, Ghana`
              : g.label)
          : g.lat > 4.5 && g.lat < 11.3 && g.lng > -3.3 && g.lng < 1.3
            ? `${g.label}, Ghana`
            : g.label,
        lat: g.lat,
        lng: g.lng,
        type: gazetteerType(g),
      }))
      .filter((g) => distKm(biasLat!, biasLng!, g.lat, g.lng) < 25);
    if (extra.length > 0) {
      results = [...extra, ...results];
      source = "merged";
    }
  }

  results = dedupe(results).slice(0, 8);
  results = nearbyRank(results, biasLat, biasLng);

  cache.set(cacheKey, { at: Date.now(), results });
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  return NextResponse.json({
    results,
    // degraded = no upstream AND no local matches — genuinely dead state.
    degraded: !upstreamOk && results.length === 0,
    source,
  });
}
