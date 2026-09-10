/**
 * Reverse-geocode proxy — turn a lat/lng (from GPS or a dragged pin) into a
 * human-readable address string so we can auto-fill the Address field when
 * the customer drops a pin.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; label: string }>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ label: "" }, { status: 400 });
  }
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ label: hit.label });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let label = "";

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      {
        signal: controller.signal,
        headers: { "User-Agent": "GoMina360/1.0 (+order page address autocomplete)" },
      },
    );
    if (res.ok) {
      const data = await res.json() as any;
      label = String(data.display_name || "").trim();
    }
  } catch {
    /* ignore */
  }

  if (!label) {
    try {
      const res = await fetch(
        `https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}`,
        {
          signal: controller.signal,
          headers: { "User-Agent": "GoMina360/1.0" },
        },
      );
      if (res.ok) {
        const data = await res.json() as any;
        const f = data?.features?.[0]?.properties || {};
        const parts = [
          f.name,
          f.street,
          f.housenumber ? `#${f.housenumber}` : null,
          f.city || f.town || f.village || f.district,
          f.state,
          f.country,
        ].filter(Boolean);
        label = parts.join(", ");
      }
    } catch {
      /* ignore */
    }
  }

  clearTimeout(timer);

  // Offline/sandbox fallback — when neither reverse-geocode upstream is
  // reachable, fall back to a nearest-neighbour lookup against the same
  // curated gazetteer. Distance is haversine-ish (degrees, fine enough for a
  // demo label).
  if (!label) {
    const places: { label: string; lat: number; lng: number }[] = [
      { label: "Makola Market, Accra, Ghana", lat: 5.5489, lng: -0.2094 },
      { label: "Accra Central, Greater Accra, Ghana", lat: 5.556, lng: -0.203 },
      { label: "Osu Oxford Street, Osu, Accra, Ghana", lat: 5.565, lng: -0.182 },
      { label: "East Legon, Accra, Ghana", lat: 5.638, lng: -0.163 },
      { label: "Airport Residential Area, Accra, Ghana", lat: 5.596, lng: -0.176 },
      { label: "Spintex Road, Accra, Ghana", lat: 5.632, lng: -0.095 },
      { label: "Tema Community 1, Tema, Ghana", lat: 5.670, lng: -0.020 },
      { label: "Adum, Kumasi, Ashanti, Ghana", lat: 6.692, lng: -1.622 },
      { label: "Kumasi Central Market, Kumasi, Ghana", lat: 6.69, lng: -1.618 },
      { label: "Tamale Central, Northern, Ghana", lat: 9.400, lng: -0.839 },
      { label: "Takoradi Market Circle, Takoradi, Ghana", lat: 4.900, lng: -1.775 },
      { label: "Cape Coast, Ghana", lat: 5.106, lng: -1.246 },
    ];
    let best: (typeof places)[number] | null = null;
    let bestD = Infinity;
    for (const p of places) {
      const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD < 2.0) {
      const suffix = `${lat.toFixed(5)}, ${lng.toFixed(6)}`;
      label = `${best.label} (near ${suffix})`;
    } else {
      label = `Custom pin ${lat.toFixed(5)}, ${lng.toFixed(6)}`;
    }
  }

  cache.set(key, { at: Date.now(), label });
  if (cache.size > 200) {
    const oldestKey = Array.from(cache.keys())[0];
    if (oldestKey) cache.delete(oldestKey);
  }
  return NextResponse.json({ label });
}
