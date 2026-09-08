export type CurrencyCode = "GHS" | "USD" | "EUR" | "GBP" | "NGN" | "XOF";

export interface CurrencyConfig {
  code: CurrencyCode;
  symbol: string;
  name: string;
  rateFromGhs: number; // Multiply GH₵ amount by this rate
}

export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  GHS: {
    code: "GHS",
    symbol: "GH₵",
    name: "Ghanaian Cedi (Default)",
    rateFromGhs: 1.0,
  },
  USD: {
    code: "USD",
    symbol: "$",
    name: "US Dollar (USD)",
    rateFromGhs: 0.065, // approx ~15.4 GHS per 1 USD
  },
  EUR: {
    code: "EUR",
    symbol: "€",
    name: "Euro (EUR)",
    rateFromGhs: 0.06,
  },
  GBP: {
    code: "GBP",
    symbol: "£",
    name: "British Pound (GBP)",
    rateFromGhs: 0.051,
  },
  NGN: {
    code: "NGN",
    symbol: "₦",
    name: "Nigerian Naira (NGN)",
    rateFromGhs: 102.5,
  },
  XOF: {
    code: "XOF",
    symbol: "CFA ",
    name: "West African CFA Franc (XOF)",
    rateFromGhs: 39.5,
  },
};

/**
 * Converts a GH₵ amount to the selected target currency and formats as a string.
 */
export function formatMoney(
  amountGhs: number | undefined | null,
  currencyCode: CurrencyCode = "GHS",
  compact: boolean = false
): string {
  if (amountGhs === undefined || amountGhs === null || isNaN(amountGhs)) {
    return `${CURRENCIES[currencyCode].symbol} 0.00`;
  }

  const config = CURRENCIES[currencyCode] || CURRENCIES.GHS;
  const converted = amountGhs * config.rateFromGhs;

  if (compact && Math.abs(converted) >= 1_000_000) {
    return `${config.symbol} ${(converted / 1_000_000).toFixed(2)}M`;
  }
  if (compact && Math.abs(converted) >= 1_000) {
    return `${config.symbol} ${(converted / 1_000).toFixed(1)}k`;
  }

  const formattedNumber = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(converted);

  return `${config.symbol} ${formattedNumber}`;
}

/**
 * Returns raw converted numeric value for charts & calculations
 */
export function convertGhs(amountGhs: number, currencyCode: CurrencyCode = "GHS"): number {
  const config = CURRENCIES[currencyCode] || CURRENCIES.GHS;
  return Number((amountGhs * config.rateFromGhs).toFixed(2));
}
