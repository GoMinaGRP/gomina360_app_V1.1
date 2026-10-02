/**
 * Boutique size & colour registry — the PURE, client-safe half of the
 * Boutique business type.
 *
 * A Boutique product is an ordinary inventory item (same Inventory, Sales,
 * Finance, Orders, Reports and Audit backbones as every other unit) that —
 * when the OWNER opts in — carries SIZE / COLOUR variants, each with its own
 * stock quantity. This module owns the size systems (letter, shoe, numeric,
 * custom), the colour palette and the small normalisation helpers; the
 * server-side half (`@/lib/boutique`) owns the database work.
 *
 * No imports from @/db here: client components bundle this file.
 */

/** Size systems a Boutique owner can pick from when building a product. */
export const SIZE_SYSTEMS = [
  {
    key: "LETTER",
    label: "Letter sizes (XS – XXL)",
    sizes: ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL"],
  },
  {
    key: "SHOE_UK",
    label: "Shoe sizes — UK",
    sizes: ["UK 3", "UK 4", "UK 5", "UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11", "UK 12"],
  },
  {
    key: "SHOE_EU",
    label: "Shoe sizes — EU",
    sizes: ["EU 35", "EU 36", "EU 37", "EU 38", "EU 39", "EU 40", "EU 41", "EU 42", "EU 43", "EU 44", "EU 45", "EU 46"],
  },
  {
    key: "SHOE_US",
    label: "Shoe sizes — US",
    sizes: ["US 4", "US 5", "US 6", "US 7", "US 8", "US 9", "US 10", "US 11", "US 12", "US 13"],
  },
  {
    key: "NUMERIC",
    label: "Numeric sizes (28 – 46)",
    sizes: ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"],
  },
  {
    key: "KIDS",
    label: "Kids & baby (ages)",
    sizes: ["0-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-4Y", "5-6Y", "7-8Y", "9-10Y", "11-12Y"],
  },
  {
    key: "FREE",
    label: "Free size / One size",
    sizes: ["FREE SIZE", "ONE SIZE"],
  },
  {
    key: "CUSTOM",
    label: "Custom size (type any value)",
    sizes: [],
  },
] as const;

export type SizeSystemKey = (typeof SIZE_SYSTEMS)[number]["key"];

export const SIZE_SYSTEM_KEYS = SIZE_SYSTEMS.map((s) => s.key) as string[];

export function sizeSystemLabel(key: string | null | undefined): string {
  const hit = SIZE_SYSTEMS.find((s) => s.key === (key || "").toUpperCase());
  return hit?.label || "Custom size";
}

export function sizesForSystem(key: string | null | undefined): string[] {
  const hit = SIZE_SYSTEMS.find((s) => s.key === (key || "").toUpperCase());
  return hit ? [...hit.sizes] : [];
}

/** Colour palette offered as one-tap chips (owners may still type custom). */
export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "Black", hex: "#111827" },
  { name: "White", hex: "#f8fafc" },
  { name: "Navy", hex: "#1e3a8a" },
  { name: "Blue", hex: "#2563eb" },
  { name: "Sky Blue", hex: "#38bdf8" },
  { name: "Grey", hex: "#94a3b8" },
  { name: "Beige", hex: "#e7d3b1" },
  { name: "Brown", hex: "#78350f" },
  { name: "Cream", hex: "#fef3c7" },
  { name: "Red", hex: "#dc2626" },
  { name: "Wine", hex: "#7f1d1d" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Purple", hex: "#7c3aed" },
  { name: "Green", hex: "#16a34a" },
  { name: "Olive", hex: "#4d7c0f" },
  { name: "Yellow", hex: "#facc15" },
  { name: "Orange", hex: "#f97316" },
  { name: "Gold", hex: "#d4af37" },
  { name: "Silver", hex: "#cbd5e1" },
  { name: "Multi", hex: "linear-gradient(135deg,#ef4444,#facc15,#22c55e,#3b82f6)" },
];

export function colorHex(name: string | null | undefined): string | null {
  const norm = (name || "").trim().toLowerCase();
  if (!norm) return null;
  const hit = COLOR_PRESETS.find((c) => c.name.toLowerCase() === norm);
  return hit ? hit.hex : null;
}

/** Hard caps — a single product can carry at most this many combinations. */
export const MAX_VARIANTS_PER_ITEM = 120;
export const MAX_SIZE_LEN = 24;
export const MAX_COLOR_LEN = 24;

/** Clean a size / colour value: trim, collapse spaces, drop control chars. */
export function cleanVariantValue(raw: unknown, maxLen = MAX_SIZE_LEN): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Normalised comparison key (case/space-insensitive) for de-duplication. */
export function variantKeyOf(size: unknown, color: unknown): string {
  const s = cleanVariantValue(size).toUpperCase();
  const c = cleanVariantValue(color, MAX_COLOR_LEN).toUpperCase();
  return `${s}||${c}`;
}

/** Human label for one variant row ("Size M · Black", "Black", "Size 42"). */
export function variantLabel(size: string | null | undefined, color: string | null | undefined): string {
  const s = cleanVariantValue(size);
  const c = cleanVariantValue(color, MAX_COLOR_LEN);
  if (s && c) return `Size ${s} · ${c}`;
  if (s) return `Size ${s}`;
  if (c) return c;
  return "Standard";
}

/** "Size M · Black" suffix appended to sale/order line descriptions so the
 *  chosen size & colour travel with every order, receipt and report row. */
export function variantSuffix(size: string | null | undefined, color: string | null | undefined): string {
  const s = cleanVariantValue(size);
  const c = cleanVariantValue(color, MAX_COLOR_LEN);
  const parts: string[] = [];
  if (s) parts.push(`Size: ${s}`);
  if (c) parts.push(`Colour: ${c}`);
  return parts.length ? ` [${parts.join(" · ")}]` : "";
}

export type VariantStockRow = {
  id?: number;
  size: string;
  color: string;
  sizeSystem?: string | null;
  quantity: number;
  minStockThreshold?: number;
  sku?: string | null;
  status?: string | null;
  isActive?: boolean;
};

/**
 * Normalise a variant matrix coming from a client form:
 *  · cleans values, drops fully-empty rows,
 *  · de-duplicates by (size,color) — later rows win,
 *  · clamps quantities to >= 0,
 *  · caps the matrix at MAX_VARIANTS_PER_ITEM.
 */
export function normalizeVariantMatrix(input: unknown): VariantStockRow[] {
  const rows = Array.isArray(input) ? input : [];
  const byKey = new Map<string, VariantStockRow>();
  for (const raw of rows) {
    const r = (raw || {}) as any;
    const size = cleanVariantValue(r.size);
    const color = cleanVariantValue(r.color, MAX_COLOR_LEN);
    if (!size && !color) continue;
    const key = variantKeyOf(size, color);
    const qty = Math.max(0, Number(r.quantity) || 0);
    byKey.set(key, {
      id: r.id != null && Number.isFinite(Number(r.id)) ? Number(r.id) : undefined,
      size,
      color,
      sizeSystem: cleanVariantValue(r.sizeSystem, 16).toUpperCase() || null,
      quantity: qty,
      minStockThreshold: Math.max(0, Number(r.minStockThreshold) || 0),
      sku: r.sku ? cleanVariantValue(r.sku, 60) : null,
      status: r.status ? String(r.status).toUpperCase() : null,
      isActive: r.isActive === false ? false : true,
    });
  }
  return Array.from(byKey.values()).slice(0, MAX_VARIANTS_PER_ITEM);
}

/** Distinct sizes (in the order first seen) + distinct colours of a matrix. */
export function axesOf(matrix: VariantStockRow[]): { sizes: string[]; colors: string[] } {
  const sizes: string[] = [];
  const colors: string[] = [];
  for (const r of matrix) {
    if (r.size && !sizes.includes(r.size)) sizes.push(r.size);
    if (r.color && !colors.includes(r.color)) colors.push(r.color);
  }
  return { sizes, colors };
}
