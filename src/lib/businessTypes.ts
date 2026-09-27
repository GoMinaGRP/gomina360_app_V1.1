// The pure registry + helpers live in the client-safe businessTypeKeys
// module; this server-side half re-exports them unchanged for every
// existing "@/lib/businessTypes" import and adds the DB-backed allowlist.
import { db } from "@/db";
import { organizations, organizationBusinessTypes } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  BUSINESS_TYPES,
  businessTypeKeyOf,
  businessTypeLabelOf,
  FARM_BUSINESS_TYPE_KEYS,
  isFarmBusinessCategory,
  type BusinessTypeDef,
} from "./businessTypeKeys";

export { BUSINESS_TYPES, businessTypeKeyOf, businessTypeLabelOf, FARM_BUSINESS_TYPE_KEYS, isFarmBusinessCategory };
export type { BusinessTypeDef };

const byKey = new Map(BUSINESS_TYPES.map((t) => [t.key, t]));

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
