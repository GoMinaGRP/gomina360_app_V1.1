/**
 * Business-type registry — the PURE, client-safe half of lib/businessTypes.
 *
 * Server modules import from "@/lib/businessTypes" (which adds the DB-backed
 * per-org allowlist); CLIENT components must import from HERE — the other
 * file pulls in pg via @/db and must never enter a browser bundle.
 */

export type BusinessTypeDef = {
  key: string;
  label: string; // canonical storefront label
  aliases: string[];
};

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export const BUSINESS_TYPES: BusinessTypeDef[] = [
  { key: "POULTRY_FARM", label: "Poultry Farm", aliases: ["poultry", "poultryfarm", "eggs", "broilers"] },
  { key: "BLOCK_FACTORY", label: "Block Factory", aliases: ["blockfactory", "blocks", "blockmoulding", "concrete"] },
  { key: "AQUACULTURE", label: "Aquaculture", aliases: ["aquaculture", "fishfarm", "fish", "tilapia", "catfish"] },
  { key: "LIVESTOCK", label: "Livestock", aliases: ["livestock", "cattle", "smallruminants"] },
  { key: "RESTAURANT_FOOD", label: "Restaurant & Food", aliases: ["restaurantfood", "restaurant", "food", "fooddrinks", "restaurantandfood"] },
  { key: "ELECTRONIC_SHOP", label: "Electronic Shop", aliases: ["electronicshop", "electronics", "electronicsshop", "electronicsstore", "tech"] },
  { key: "CAR_WASH", label: "Car Wash", aliases: ["carwash", "autowash", "carwashing"] },
  { key: "HARDWARE_STORE", label: "Hardware Store", aliases: ["hardwarestore", "hardware", "hardwarebuildingmaterials"] },
  { key: "TELECOM_DIGITAL", label: "Telecom & Digital Services", aliases: ["telecomdigitalservices", "telecom", "telecomdigital", "momoairtimedata"] },
  { key: "TRANSPORTATION", label: "Transportation", aliases: ["transportation", "transport", "logistics", "fleet", "haulage", "trucking"] },
];

const byKey = new Map(BUSINESS_TYPES.map((t) => [t.key, t]));
const byAlias = new Map<string, BusinessTypeDef>();
for (const t of BUSINESS_TYPES) {
  byAlias.set(norm(t.key), t);
  byAlias.set(norm(t.label), t);
  for (const a of t.aliases) byAlias.set(norm(a), t);
}

/** Resolve a free-text category to its canonical business-type key. */
export function businessTypeKeyOf(category: string | null | undefined): string {
  const c = (category || "").trim();
  if (!c) return "OTHER";
  const hit = byAlias.get(norm(c));
  if (hit) return hit.key;
  // Future/unknown type: stable derived key so it can still be granted.
  const slug = c.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "OTHER";
  return slug;
}

export function businessTypeLabelOf(category: string | null | undefined): string {
  const def = byAlias.get(norm(category || ""));
  return def ? def.label : (category || "Other");
}

/** Farm-type units — the natural monitoring scope of a FARM_ADVISOR. Grants
 *  are NOT technically limited to these (the OWNER decides), but every
 *  advisor-facing surface uses this one helper to highlight farm units. */
export const FARM_BUSINESS_TYPE_KEYS = ["POULTRY_FARM", "AQUACULTURE", "LIVESTOCK"] as const;

export function isFarmBusinessCategory(category: string | null | undefined): boolean {
  return (FARM_BUSINESS_TYPE_KEYS as readonly string[]).includes(businessTypeKeyOf(category));
}
