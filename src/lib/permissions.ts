/**
 * Pure, client-safe permission helpers — NO database or server imports, so
 * both React components and API routes can use them.
 *
 * "Business manager" (OWNER-delegated) semantics:
 *   • The OWNER always has owner-equivalent power over every unit.
 *   • Any other user holds owner-equivalent power over a unit ONLY while the
 *     OWNER has granted that unit via `users.businessManageIds`.
 *   • Every other business/branch stays out of reach.
 */

/** The business ids a user may manage with owner-equivalent power (OWNER ⇒ []). */
export function businessManageIdsOf(user: any): number[] {
  if (!user) return [];
  const ids = user?.businessManageIds;
  if (!Array.isArray(ids)) return [];
  return ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** True when the user is the group OWNER. */
export function isOwner(user: any): boolean {
  return !!user && user.role === "OWNER";
}

/** True when the user may manage `businessId` with owner-equivalent power. */
export function managesBusiness(user: any, businessId: number | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "OWNER") return true;
  if (businessId == null) return false;
  return businessManageIdsOf(user).includes(Number(businessId));
}

/** Alias — owner-equivalent power over a specific unit. */
export function isOwnerOfBusiness(user: any, businessId: number | null | undefined): boolean {
  return managesBusiness(user, businessId);
}
