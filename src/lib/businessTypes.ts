import { db } from "@/db";
import { organizations, organizationBusinessTypes } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Canonical business-type registry — the vocabulary of the per-Owner
 * "Allowed Business Types" permission.
 *
 * Business categories historically live as free text on `businesses.category`
 * (seeded canonical strings). Every known spelling/synonym normalises to a
 * stable key so an allowlist survives label tweaks. Unknown categories keep a
 * derived CUSTOM-* key: unrestricted orgs pass them through (back-compat),
 * restricted orgs must have them granted explicitly.
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

export type AllowedBusinessTypes = {
  restricted: boolean;
  keys: string[]; // canonical keys (all types when restricted=false)
  labelsAndKeys: { key: string; label: string }[];
};

/** The allowed-set for one organization. restricted=false ⇒ everything allowed,
 *  including every type that arrives in the future. */
export async function allowedBusinessTypesOfOrg(orgId: number | null | undefined): Promise<AllowedBusinessTypes> {
  if (orgId == null) {
    return { restricted: false, keys: BUSINESS_TYPES.map((t) => t.key), labelsAndKeys: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })) };
  }
  const [org] = await db
    .select({ businessTypesRestricted: organizations.businessTypesRestricted })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const restricted = org?.businessTypesRestricted === true;
  if (!restricted) {
    return { restricted: false, keys: BUSINESS_TYPES.map((t) => t.key), labelsAndKeys: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })) };
  }
  const rows = await db
    .select({ businessTypeKey: organizationBusinessTypes.businessTypeKey })
    .from(organizationBusinessTypes)
    .where(eq(organizationBusinessTypes.organizationId, orgId));
  const keys = rows.map((r) => String(r.businessTypeKey));
  return {
    restricted: true,
    keys,
    labelsAndKeys: keys.map((k) => ({ key: k, label: byKey.get(k)?.label ?? k })),
  };
}

/** May an actor inside org `orgId` create / re-type a business of `category`?
 *  The platform Super Admin is unrestricted; unrestricted orgs always pass;
 *  restricted orgs must list the type's canonical key. */
export async function businessTypeAllowed(
  orgId: number | null | undefined,
  category: string | null | undefined,
  isSuperAdmin: boolean,
): Promise<{ allowed: boolean; key: string }> {
  const key = businessTypeKeyOf(category);
  if (isSuperAdmin) return { allowed: true, key };
  if (orgId == null) return { allowed: true, key };
  const allowed = await allowedBusinessTypesOfOrg(orgId);
  if (!allowed.restricted) return { allowed: true, key };
  return { allowed: allowed.keys.includes(key), key };
}
