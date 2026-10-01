export type CurrencyCode = "GHS" | "USD" | "EUR" | "GBP" | "NGN" | "XOF" | "CNY";

export interface CurrencyConfig {
  code: CurrencyCode;
  symbol: string;
  name: string;
  /** Multiply a GHS amount by this rate for display only. Stored values stay in GHS. */
  rateFromGhs: number;
  decimals: number;
}

export interface CurrencyRatesPayload {
  base: "GHS";
  rates: Partial<Record<CurrencyCode, number>>;
  source?: string;
  fetchedAt?: string;
  fallback?: boolean;
}

/** Conservative last-known fallbacks. Runtime rates come from /api/currency/rates. */
const FALLBACK_RATE_FROM_GHS: Record<CurrencyCode, number> = {
  GHS: 1,
  USD: 0.065,
  EUR: 0.060,
  GBP: 0.051,
  NGN: 102.5,
  XOF: 39.5,
  CNY: 0.47,
};

export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  GHS: {
    code: "GHS",
    symbol: "GH₵",
    name: "Ghanaian Cedi (GHS)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.GHS,
    decimals: 2,
  },
  USD: {
    code: "USD",
    symbol: "$",
    name: "US Dollar (USD)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.USD,
    decimals: 2,
  },
  EUR: {
    code: "EUR",
    symbol: "€",
    name: "Euro (EUR)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.EUR,
    decimals: 2,
  },
  GBP: {
    code: "GBP",
    symbol: "£",
    name: "British Pound (GBP)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.GBP,
    decimals: 2,
  },
  NGN: {
    code: "NGN",
    symbol: "₦",
    name: "Nigerian Naira (NGN)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.NGN,
    decimals: 2,
  },
  XOF: {
    code: "XOF",
    symbol: "CFA",
    name: "West African CFA Franc (XOF)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.XOF,
    decimals: 0,
  },
  CNY: {
    code: "CNY",
    symbol: "¥",
    name: "Chinese Yuan (CNY)",
    rateFromGhs: FALLBACK_RATE_FROM_GHS.CNY,
    decimals: 2,
  },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

const finitePositive = (n: any) => Number.isFinite(Number(n)) && Number(n) > 0;

export function normalizeCurrencyCode(code: unknown): CurrencyCode {
  const c = String(code || "GHS").toUpperCase();
  return (CURRENCY_CODES as string[]).includes(c) ? (c as CurrencyCode) : "GHS";
}

export function getRateFromGhs(currencyCode: CurrencyCode = "GHS"): number {
  return CURRENCIES[normalizeCurrencyCode(currencyCode)].rateFromGhs || 1;
}

/**
 * Applies verified GHS-base exchange rates for display conversion only.
 * This intentionally mutates only the client/server process' currency table;
 * database financial values remain stored and posted in original GHS fields.
 */
export function applyCurrencyRates(rates: Partial<Record<CurrencyCode, number>> | null | undefined): boolean {
  if (!rates) return false;
  let changed = false;
  for (const code of CURRENCY_CODES) {
    const next = code === "GHS" ? 1 : Number(rates[code]);
    if (!finitePositive(next)) continue;
    if (Math.abs(CURRENCIES[code].rateFromGhs - next) > 0.0000001) {
      CURRENCIES[code].rateFromGhs = next;
      changed = true;
    }
  }
  return changed;
}

export function currentCurrencyRates(): Record<CurrencyCode, number> {
  return Object.fromEntries(CURRENCY_CODES.map((code) => [code, CURRENCIES[code].rateFromGhs])) as Record<CurrencyCode, number>;
}

function formatNumericAmount(amount: number, currencyCode: CurrencyCode, compact = false): string {
  const config = CURRENCIES[normalizeCurrencyCode(currencyCode)];
  const decimals = config.decimals;
  const abs = Math.abs(amount);
  const suffix = compact && abs >= 1_000_000 ? "M" : compact && abs >= 1_000 ? "k" : "";
  const scaled = suffix === "M" ? amount / 1_000_000 : suffix === "k" ? amount / 1_000 : amount;
  const formattedNumber = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: suffix ? Math.min(decimals, 1) : decimals,
    maximumFractionDigits: suffix ? Math.min(Math.max(decimals, 1), 2) : decimals,
  }).format(scaled);
  return `${config.symbol} ${formattedNumber}${suffix}`;
}

/** Formats an amount that is already denominated in the selected currency. */
export function formatCurrencyAmount(
  amount: number | undefined | null,
  currencyCode: CurrencyCode = "GHS",
  compact = false,
): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return formatNumericAmount(0, normalizeCurrencyCode(currencyCode), compact);
  return formatNumericAmount(numeric, normalizeCurrencyCode(currencyCode), compact);
}

/**
 * Converts a GHS amount to the selected target currency and formats it.
 * IMPORTANT: callers pass GHS ledger values; conversion is display-only.
 */
export function formatMoney(
  amountGhs: number | undefined | null,
  currencyCode: CurrencyCode = "GHS",
  compact = false,
): string {
  return formatCurrencyAmount(convertGhs(Number(amountGhs) || 0, currencyCode), currencyCode, compact);
}

/** Returns raw converted numeric value for charts & display calculations. */
export function convertGhs(amountGhs: number | undefined | null, currencyCode: CurrencyCode = "GHS"): number {
  const numeric = Number(amountGhs);
  if (!Number.isFinite(numeric)) return 0;
  const rate = getRateFromGhs(currencyCode);
  const decimals = Math.min(6, Math.max(2, CURRENCIES[normalizeCurrencyCode(currencyCode)].decimals));
  return Number((numeric * rate).toFixed(decimals));
}

/** Explicit formatter for customer-facing marketplace/order pages — always GHS. */
export function formatGhs(amountGhs: number | undefined | null, compact = false): string {
  return formatMoney(amountGhs, "GHS", compact);
}

const LS_RATES_KEY = "gomina.currency.rates.v1";
const LS_CODE_KEY = "gomina.currency.code.v1";
const CLIENT_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function readCachedCurrencyRates(): CurrencyRatesPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_RATES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CurrencyRatesPayload;
    const fetchedMs = parsed.fetchedAt ? Date.parse(parsed.fetchedAt) : 0;
    if (!fetchedMs || Date.now() - fetchedMs > CLIENT_CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function cacheCurrencyRates(payload: CurrencyRatesPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_RATES_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be blocked in embedded/private contexts; fallback rates still work.
  }
}

export function readStoredCurrencyCode(): CurrencyCode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_CODE_KEY);
    return raw ? normalizeCurrencyCode(raw) : null;
  } catch {
    return null;
  }
}

export function storeCurrencyCode(code: CurrencyCode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_CODE_KEY, normalizeCurrencyCode(code));
  } catch {
    // non-critical preference persistence
  }
}
