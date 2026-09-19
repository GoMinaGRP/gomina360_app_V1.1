/**
 * Feed quantity units — KG is the single canonical quantity everywhere in the
 * database and in every calculation. Bags and tonnes are INPUT/DISPLAY
 * conveniences only; they are converted to kg here, server-side, and never
 * stored as such. Supported units (standardized Ghana market practice):
 *   KG     — kilograms (base)
 *   BAG25  — 25 kg bag (premixes, concentrates)
 *   BAG50  — 50 kg bag (maize, bran, milled feeds)
 *   TONNE  — 1,000 kg (bulk purchases / large contracts)
 */
export const FEED_UNITS = [
  { key: "KG", label: "Kilograms (kg)", kg: 1 },
  { key: "BAG25", label: "25-kg bag", kg: 25 },
  { key: "BAG50", label: "50-kg bag", kg: 50 },
  { key: "TONNE", label: "Tonne (1,000 kg)", kg: 1000 },
] as const;

export type FeedUnitKey = (typeof FEED_UNITS)[number]["key"];

const unitKg = (u: string | null | undefined): number => {
  const hit = FEED_UNITS.find((x) => x.key === String(u || "").toUpperCase());
  return hit ? hit.kg : 1; // unknown units safely fall back to kg
};

/** qty in the given unit → canonical kg (rounded to 3dp). */
export function feedToKg(qty: number, unit: string | null | undefined): number {
  const q = Number(qty) || 0;
  return Math.round(q * unitKg(unit) * 1000) / 1000;
}

/** kg → the given unit (rounded to 3dp). */
export function kgToFeedUnit(kg: number, unit: string | null | undefined): number {
  const k = unitKg(unit);
  const q = Number(kg) || 0;
  return Math.round((q / k) * 1000) / 1000;
}

/**
 * human display for a kg quantity, e.g. "1,250 kg (25 × 50-kg bags)".
 * Bags fraction shown only when ≥ 0.25 of the chosen bag size.
 */
export function fmtKg(kg: number, opts: { bag?: "BAG25" | "BAG50" | null } = {}): string {
  const q = Number(kg) || 0;
  const base = `${q.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
  const bag = opts.bag === "BAG25" ? 25 : 50;
  const bags = q / bag;
  if (Math.abs(bags) < 0.25) return base;
  return `${base} (${bags.toLocaleString(undefined, { maximumFractionDigits: bags % 1 ? 1 : 0 })} × ${bag}-kg bags)`;
}
