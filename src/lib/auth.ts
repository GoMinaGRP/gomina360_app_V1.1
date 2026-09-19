import crypto from "crypto";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users, userSessions, userBusinessAccess, organizationMembers, organizations, businesses } from "@/db/schema";
import { businessManageIdsOf } from "./permissions";

/**
 * GoMina 360 authentication & access control.
 *
 * - Passwords: scrypt with a per-user random salt ("scrypt:<salt>:<hash>", hex).
 * - Sessions: 32-byte random bearer token in an httpOnly, SameSite=Lax cookie;
 *   only the SHA-256 hash is stored server-side (leak ⇒ useless).
 * - Access: the platform Super Admin sees everything; an organization OWNER
 *   sees all businesses of THEIR organization; every other user sees their
 *   primary assigned business plus granted businesses — always intersected
 *   with their own organization(s). Users can never cross an org boundary.
 */

export const SESSION_COOKIE = "gomina_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Absolute idle ceiling: a session with NO authenticated request for this
 * long is ended (belt-and-suspenders for the client-side idle auto-logout,
 * which fires on DOM inactivity while the app is simply left open). */
export const SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  try {
    const hash = crypto.scryptSync(password, salt, 64);
    const expectedBuf = Buffer.from(expected, "hex");
    if (hash.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(hash, expectedBuf);
  } catch {
    return false;
  }
}

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export async function createSession(userId: number) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  await db.insert(userSessions).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { token, expires: new Date(Date.now() + SESSION_TTL_MS) };
}

export async function destroySession(token: string | null | undefined) {
  if (!token) return;
  // Soft end: keep the row so the access console can report the exact
  // last-login/last-logout times; ended rows are never usable again.
  await db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: "LOGOUT" })
    .where(and(eq(userSessions.tokenHash, sha256(token)), isNull(userSessions.endedAt)));
}

/** Immediately end EVERY live session of a user (access cut, force sign-out). */
export async function endAllSessionsForUser(userId: number, reason: string) {
  await db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: reason })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)));
}

export function readSessionToken(request: Request): string | null {
  // Channel 1 (primary): the httpOnly session cookie.
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) return decodeURIComponent(match[1]);
  // Channel 2 (embedded-preview fallback): a bearer token the client keeps in
  // sessionStorage and attaches to every /api/* call. Browsers that hard-block
  // third-party cookies inside cross-site iframes still permit headers, so
  // sign-in survives where cookie-only auth "blinks and bounces" back to login.
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const hdr = request.headers.get("x-gomina-session");
  return hdr ? hdr.trim() : null;
}

export interface SessionInfo {
  sessionId: number;
  user: any;
  /** The user's primary organization (null only for orphaned/bootstrap users). */
  orgId: number | null;
  /** All organizations the user is a member of. */
  orgIds: number[];
  isSuperAdmin: boolean;
}

/** Load the organization ids a user belongs to. Result is cached on the user
 *  object (session-enriched rows carry it already; raw table rows get one DB hit). */
export async function resolveUserOrgIds(user: any): Promise<number[]> {
  if (!user) return [];
  if (Array.isArray(user.organizationIds)) return user.organizationIds;
  if (user.primaryOrgId) {
    const rows = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, user.id));
    const ids = rows.map((r) => Number(r.organizationId));
    const primary = Number(user.primaryOrgId);
    const all = ids.includes(primary) ? ids : [primary, ...ids];
    return all.length ? all : [primary];
  }
  const rows = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id));
  return rows.map((r) => Number(r.organizationId));
}

/** All business ids owned by any of the given organizations. */
export async function businessIdsOfOrgs(orgIds: number[]): Promise<number[]> {
  if (!orgIds.length) return [];
  const rows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(inArray(businesses.ownerId, orgIds));
  return rows.map((r) => Number(r.id));
}

export const isSuperAdmin = (user: any): boolean => !!user?.isSuperAdmin;

/** Resolve the acting user from the session cookie. Returns null if unauthenticated. */
export async function getSessionInfo(request: Request): Promise<SessionInfo | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = sha256(token);
  const rows = await db
    .select({ session: userSessions, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.endedAt)));
  const row = rows[0];
  if (!row) return null;
  const now = new Date();
  if (row.session.expiresAt && new Date(row.session.expiresAt) < now) {
    await db
      .update(userSessions)
      .set({ endedAt: new Date(), endReason: "EXPIRED" })
      .where(eq(userSessions.id, row.session.id));
    return null;
  }
  if (row.user.isActive === false) return null;
  // Idle expiry — checked BEFORE the keepalive below would refresh it: no
  // authenticated request for 10 straight minutes ends the session.
  const lastActivity = row.session.lastSeenAt
    ? new Date(row.session.lastSeenAt).getTime()
    : row.session.createdAt
      ? new Date(row.session.createdAt).getTime()
      : Date.now();
  if (Date.now() - lastActivity > SESSION_IDLE_MS) {
    await db
      .update(userSessions)
      .set({ endedAt: new Date(), endReason: "IDLE_TIMEOUT" })
      .where(eq(userSessions.id, row.session.id));
    return null;
  }
  // Sliding keepalive (throttled to ~1 write / 60s). A real request also
  // un-parks the session (revokedAt) — the user is demonstrably present.
  const lastSeen = row.session.lastSeenAt ? new Date(row.session.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeen > 60_000 || row.session.revokedAt) {
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(), revokedAt: null })
      .where(eq(userSessions.id, row.session.id));
  }

  // ── Organization (tenant) context ─────────────────────────────────────
  const membershipRows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      isPrimary: organizationMembers.isPrimary,
      status: organizations.status,
    })
    .from(organizationMembers)
    .leftJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, row.user.id));
  const superAdmin = row.user.isSuperAdmin === true;
  const orgIds = membershipRows.map((m) => Number(m.organizationId)).filter(Number.isFinite);
  // NaN is not nullish (?? does not rescue it) — normalize with a helper
  // before any nullable-fallback chain.
  const numOrNull = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const primaryOrgId =
    (row.user.primaryOrgId && orgIds.includes(Number(row.user.primaryOrgId)) ? numOrNull(row.user.primaryOrgId) : null) ??
    numOrNull(membershipRows.find((m) => m.isPrimary)?.organizationId) ??
    orgIds[0] ??
    numOrNull(row.user.primaryOrgId);
  // A SUSPENDED organization locks out every member (super admins keep their
  // platform seat — they are the ones who suspend/resume orgs).
  if (!superAdmin && orgIds.length) {
    const hasActiveOrg = membershipRows.some((m) => m.status !== "SUSPENDED");
    if (!hasActiveOrg) return null;
  }
  const user = {
    ...row.user,
    isSuperAdmin: superAdmin,
    organizationIds: orgIds,
    orgId: primaryOrgId,
  };
  return { sessionId: row.session.id, user, orgId: primaryOrgId, orgIds, isSuperAdmin: superAdmin };
}

/** Business ids a user may access. Returns null ⇒ unrestricted (Super Admin).
 *  Org OWNER ⇒ every business of their organization(s). Everyone else ⇒
 *  primary assignment ∪ extra-access grants ∪ managed units, always
 *  intersected with their own organization(s). */
export async function accessibleBusinessIds(user: any): Promise<number[] | null> {
  if (!user) return [];
  if (isSuperAdmin(user)) return null; // platform-unrestricted
  const orgIds = await resolveUserOrgIds(user);
  const orgBizIds = await businessIdsOfOrgs(orgIds);
  if (user.role === "OWNER") return orgBizIds; // org-scoped, never global
  const ids = new Set<number>();
  if (user.assignedBusinessId) ids.add(Number(user.assignedBusinessId));
  for (const m of businessManageIdsOf(user)) ids.add(m); // manage ⇒ access
  const grants = await db
    .select({ businessId: userBusinessAccess.businessId })
    .from(userBusinessAccess)
    .where(eq(userBusinessAccess.userId, user.id));
  for (const g of grants) ids.add(Number(g.businessId));
  // Legacy rows (no org recorded) keep their pre-multi-owner scope exactly:
  // the org-intersection would empty their world.
  if (orgIds.length === 0) return [...ids];
  const orgBiz = new Set(orgBizIds);
  return [...ids].filter((id) => orgBiz.has(id));
}

export async function canAccessBusiness(user: any, businessId: number): Promise<boolean> {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  const allowed = await accessibleBusinessIds(user);
  if (allowed === null) return true;
  return allowed.includes(Number(businessId));
}

/** True when the actor and target share at least one organization. */
export async function sharesOrganization(a: any, b: any): Promise<boolean> {
  const aIds = await resolveUserOrgIds(a);
  const bIds = await resolveUserOrgIds(b);
  // Legacy rows may carry no org record at all (they predate multi-owner):
  // two org-less users share the legacy universe, so branch managers of the
  // demo tenant can keep administering them exactly as before.
  if (aIds.length === 0 && bIds.length === 0) return true;
  return aIds.some((id) => bIds.includes(id));
}

/** May `actor` administer `target` (edit flags, reset password, deactivate…)?
 *  Super admin ⇒ yes (platform-wide). Org OWNER ⇒ only inside shared orgs.
 *  Others ⇒ no (handled by callers' own flags). */
export async function canAdministerUser(actor: any, target: any): Promise<boolean> {
  if (!actor || !target) return false;
  if (isSuperAdmin(actor)) return true;
  if (isSuperAdmin(target)) return false; // only a super admin touches a super admin
  if (actor.role !== "OWNER") return false;
  return sharesOrganization(actor, target);
}

/** Filter an array of rows carrying .businessId to those the user may access. */
export function filterByAccess<T extends { businessId?: number | null }>(rows: T[], allowed: number[] | null): T[] {
  if (allowed === null) return rows;
  const set = new Set(allowed);
  return rows.filter((r) => r.businessId != null && set.has(Number(r.businessId)));
}

/** Session-resolved OWNER gate for mutation routes (replaces spoofable body roles).
 *  Passes for org OWNERs and the platform Super Admin (role stays OWNER). */
export async function requireOwner(request: Request): Promise<any | null> {
  const info = await getSessionInfo(request);
  if (!info || info.user.role !== "OWNER") return null;
  return info.user;
}

/** Session-resolved Super Admin gate for platform-level routes (org lifecycle). */
export async function requireSuperAdmin(request: Request): Promise<any | null> {
  const info = await getSessionInfo(request);
  if (!info || !info.user.isSuperAdmin) return null;
  return info.user;
}

export async function setUserPassword(userId: number, password: string) {
  await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      passwordChangedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));
}

export async function replaceUserAccess(userId: number, businessIds: number[], grantedBy: number) {
  await db.delete(userBusinessAccess).where(eq(userBusinessAccess.userId, userId));
  if (businessIds.length) {
    await db.insert(userBusinessAccess).values(
      businessIds.map((businessId) => ({ userId, businessId, createdByUserId: grantedBy }))
    );
  }
}

export async function userAccessList(userId: number): Promise<number[]> {
  const rows = await db
    .select({ businessId: userBusinessAccess.businessId })
    .from(userBusinessAccess)
    .where(eq(userBusinessAccess.userId, userId));
  return rows.map((r) => Number(r.businessId));
}

export async function usersAccessMap(userIds: number[]): Promise<Record<number, number[]>> {
  if (!userIds.length) return {};
  const rows = await db
    .select({ userId: userBusinessAccess.userId, businessId: userBusinessAccess.businessId })
    .from(userBusinessAccess)
    .where(inArray(userBusinessAccess.userId, userIds));
  const map: Record<number, number[]> = {};
  for (const r of rows) {
    if (!map[r.userId]) map[r.userId] = [];
    map[r.userId].push(Number(r.businessId));
  }
  return map;
}

export const FORBIDDEN = (msg = "You do not have permission to access this resource.") =>
  Response.json({ success: false, error: msg }, { status: 403 });
export const UNAUTHENTICATED = () =>
  Response.json({ success: false, error: "Sign in required." }, { status: 401 });
