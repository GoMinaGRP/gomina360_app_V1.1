import { NextResponse } from "next/server";
import { applyCurrencyRates, CURRENCY_CODES, currentCurrencyRates, type CurrencyCode } from "@/lib/currency";
import { ttlGet, ttlSet } from "@/lib/ttlCache";

const CACHE_KEY = "currency:ghs-rates:v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;
const SYMBOLS = CURRENCY_CODES.filter((c) => c !== "GHS").join(",");

type RatesResponse = {
  success: true;
  base: "GHS";
  rates: Record<CurrencyCode, number>;
  source: string;
  fetchedAt: string;
  fallback: boolean;
  maxAgeSeconds: number;
};

const finitePositive = (v: any) => Number.isFinite(Number(v)) && Number(v) > 0;

function fallbackPayload(reason: string): RatesResponse {
  return {
    success: true,
    base: "GHS",
    rates: currentCurrencyRates(),
    source: `fallback-static:${reason}`,
    fetchedAt: new Date().toISOString(),
    fallback: true,
    maxAgeSeconds: Math.round(CACHE_TTL_MS / 1000),
  };
}

async function fetchOpenExchangeRates(): Promise<RatesResponse> {
  // Open ExchangeRate-API endpoint (no key required) publishes daily rates.
  // It supports GHS as the base, so no cross-rate inversion is needed.
  const url = "https://open.er-api.com/v6/latest/GHS";
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`open.er-api.com HTTP ${res.status}`);
  const data = await res.json();
  if (data?.result && data.result !== "success") throw new Error(`open.er-api.com result=${data.result}`);
  const raw = data?.rates || {};
  const rates = { ...currentCurrencyRates(), GHS: 1 } as Record<CurrencyCode, number>;
  for (const code of CURRENCY_CODES) {
    if (code === "GHS") continue;
    const n = Number(raw[code]);
    if (finitePositive(n)) rates[code] = n;
  }
  const missing = CURRENCY_CODES.filter((c) => !finitePositive(rates[c]));
  if (missing.length) throw new Error(`missing rates: ${missing.join(",")}`);
  return {
    success: true,
    base: "GHS",
    rates,
    source: "open.er-api.com/v6/latest/GHS",
    fetchedAt: data?.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString() : new Date().toISOString(),
    fallback: false,
    maxAgeSeconds: Math.round(CACHE_TTL_MS / 1000),
  };
}

async function fetchFrankfurterCrossRates(): Promise<RatesResponse> {
  // Secondary source: Frankfurter/ECB does not use GHS as a base consistently,
  // but it can provide EUR cross-rates.  Convert target/GHS = target/EUR ÷ GHS/EUR.
  const url = `https://api.frankfurter.app/latest?from=EUR&to=GHS,${SYMBOLS}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.rates || {};
  const ghsPerEur = Number(raw.GHS);
  if (!finitePositive(ghsPerEur)) throw new Error("frankfurter missing GHS cross-rate");
  const rates = { ...currentCurrencyRates(), GHS: 1 } as Record<CurrencyCode, number>;
  for (const code of CURRENCY_CODES) {
    if (code === "GHS") continue;
    const perEur = Number(raw[code]);
    if (finitePositive(perEur)) rates[code] = perEur / ghsPerEur;
  }
  return {
    success: true,
    base: "GHS",
    rates,
    source: "frankfurter.app/latest EUR cross-rate",
    fetchedAt: data?.date ? new Date(`${data.date}T00:00:00Z`).toISOString() : new Date().toISOString(),
    fallback: false,
    maxAgeSeconds: Math.round(CACHE_TTL_MS / 1000),
  };
}

export async function GET() {
  const cached = ttlGet<RatesResponse>(CACHE_KEY);
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=21600, stale-while-revalidate=86400",
        "X-Currency-Cache": "hit",
      },
    });
  }

  let payload: RatesResponse;
  try {
    payload = await fetchOpenExchangeRates();
  } catch (primaryError: any) {
    try {
      payload = await fetchFrankfurterCrossRates();
    } catch (secondaryError: any) {
      payload = fallbackPayload(`${primaryError?.message || "primary"};${secondaryError?.message || "secondary"}`);
    }
  }
  applyCurrencyRates(payload.rates);
  ttlSet(CACHE_KEY, payload, CACHE_TTL_MS);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=21600, stale-while-revalidate=86400",
      "X-Currency-Cache": "miss",
    },
  });
}
