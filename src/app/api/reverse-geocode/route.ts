/**
 * Reverse-geocode proxy — turn a lat/lng (from GPS or a dragged pin) into a
 * human-readable address string so we can auto-fill the Address field when
 * the customer drops a pin.
 */
import { NextResponse } from "next/server";
import { GHANA_GAZETTEER } from "@/lib/ghanaGazetteer";

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

  // Offline fallback — nearest-neighbour over the curated Ghana gazetteer
  // (src/lib/ghanaGazetteer.ts). Degrees² is fine at this zoom (~1 km scale).
  if (!label) {
    let best: (typeof GHANA_GAZETTEER)[number] | null = null;
    let bestD = Infinity;
    for (const g of GHANA_GAZETTEER) {
      const d = (g.lat - lat) ** 2 + (g.lng - lng) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best && bestD < 0.04 /* ~4 km */) {
      label = `${best.label}, Ghana (near ${lat.toFixed(5)}, ${lng.toFixed(6)})`;
    } else if (best && bestD < 0.5 /* ~25 km */) {
      label = `Near ${best.label}, Ghana (${lat.toFixed(5)}, ${lng.toFixed(6)})`;
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
