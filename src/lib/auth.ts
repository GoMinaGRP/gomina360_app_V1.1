import crypto from "crypto";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, userSessions, userBusinessAccess, organizationMembers, organizations, businesses, advisorAssignments } from "@/db/schema";
import { businessManageIdsOf } from "./permissions";
import { mapRawRow } from "./rawRowMapper";

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
 * which fires on DOM inactivity while the app is simply left open).
 * Policy 2026-09: 24 hours of inactivity before a session is retired —
 * aligned with the client-side IdleLogout window (see IdleLogout.tsx). */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
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

/** Sign-in provenance for the Signed-In Staff console (Phase C).
 *  Raw IPs are never persisted — only a salted hash for security review. */
export function hashClientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0].trim() : "") || request.headers.get("x-real-ip") || "";
  if (!ip) return null;
  return sha256(`${process.env.IP_HASH_SALT || "gomina360-local"}:${ip}`);
}

/** Compact, human-friendly UA summary ("Chrome · Android"), falsy-safe. */
export function deviceLabel(request: Request): { label: string | null; raw: string | null } {
  const raw = (request.headers.get("user-agent") || "").slice(0, 220) || null;
  if (!raw) return { label: null, raw: null };
  const lenient = raw.toLowerCase();
  const os = lenient.includes("windows") ? "Windows"
    : lenient.includes("android") ? "Android"
    : lenient.includes("iphone") || lenient.includes("ipad") || /mac os x/.test(lenient) && /mobile/.test(lenient) ? "iOS"
    : lenient.includes("mac os x") ? "macOS"
    : lenient.includes("linux") ? "Linux" : "Unknown OS";
  const browser = /edg\//.test(lenient) ? "Edge"
    : /opr\/|opera/.test(lenient) ? "Opera"
    : /chrome\/|crios\//.test(lenient) ? "Chrome"
    : /firefox\//.test(lenient) ? "Firefox"
    : /safari\//.test(lenient) ? "Safari" : "Browser";
  return { label: `${browser} · ${os}`, raw };
}

export async function createSession(
  userId: number,
  provenance?: { deviceLabel?: string | null; userAgent?: string | null; ipHash?: string | null; initialBusinessId?: number | null },
) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  await db.insert(userSessions).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    deviceLabel: provenance?.deviceLabel ?? null,
    userAgent: provenance?.userAgent ?? null,
    ipHash: provenance?.ipHash ?? null,
    initialBusinessId: provenance?.initialBusinessId ?? null,
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

/** External Farm Advisor / Resource Person: an invited professional with
 *  READ-ONLY farm-operations access. Their business scope comes exclusively
 *  from active, unexpired advisor_assignments (OWNER-granted) — the staff
 *  grant tables (primary assignment, user_business_access, manage
 *  delegations) deliberately NEVER apply to this role, so revocation or
 *  expiry of the assignment is the complete story of their access. */
export const isFarmAdvisor = (user: any): boolean =>
  !!user && String(user.role || "").toUpperCase() === "FARM_ADVISOR";

/** Is `user` an advisor with an ACTIVE, UNEXPIRED grant for `businessId`?
 *  (Grants are always intersected with the advisor's organization at the
 *  access-resolution layer; this check is the raw grant state.) */
export async function activeAdvisorAssignment(user: any, businessId: number): Promise<boolean> {
  if (!isFarmAdvisor(user)) return false;
  const rows = await db
    .select({ id: advisorAssignments.id, isActive: advisorAssignments.isActive, validUntil: advisorAssignments.validUntil })
    .from(advisorAssignments)
    .where(and(eq(advisorAssignments.userId, Number(user.id)), eq(advisorAssignments.businessId, Number(businessId))));
  const today = new Date().toISOString().slice(0, 10);
  return rows.some(
    (g) => g.isActive !== false && (!g.validUntil || String(g.validUntil) >= today),
  );
}

/** The advisor's per-section visibility grant for one farm unit.
 *  Returns null when the actor is not an advisor (full access path) or when
 *  the grant carries no section list (= ALL sections, the legacy default);
 *  otherwise the exact allowed section-key list from the unit's catalog
 *  (see src/lib/advisorSections.ts). Expired/revoked grants resolve to []
 *  — callers should have failed the access check before it matters. */
export async function advisorSectionsForBusiness(user: any, businessId: number): Promise<string[] | null> {
  if (!isFarmAdvisor(user)) return null;
  const rows = await db
    .select({
      isActive: advisorAssignments.isActive,
      validUntil: advisorAssignments.validUntil,
      sections: advisorAssignments.sections,
    })
    .from(advisorAssignments)
    .where(and(eq(advisorAssignments.userId, Number(user.id)), eq(advisorAssignments.businessId, Number(businessId))));
  const today = new Date().toISOString().slice(0, 10);
  const active = rows.filter((g) => g.isActive !== false && (!g.validUntil || String(g.validUntil) >= today));
  if (!active.length) return [];
  // Any active unrestricted grant wins (multiple grants for one unit are
  // collapsed by the grants UI; belt-and-braces take the most permissive).
  if (active.some((g) => g.sections === null || g.sections === undefined)) return null;
  const keys = new Set<string>();
  for (const g of active) {
    if (Array.isArray(g.sections)) g.sections.forEach((k: any) => keys.add(String(k)));
  }
  return [...keys];
}

/** All of the advisor's ACTIVE grants keyed by businessId → sections
 *  (null = all). Used by /api/init to slim the payload per unit. */
export async function advisorSectionsMap(user: any): Promise<Record<number, string[] | null>> {
  const map: Record<number, string[] | null> = {};
  if (!isFarmAdvisor(user)) return map;
  const rows = await db
    .select({
      businessId: advisorAssignments.businessId,
      isActive: advisorAssignments.isActive,
      validUntil: advisorAssignments.validUntil,
      sections: advisorAssignments.sections,
    })
    .from(advisorAssignments)
    .where(eq(advisorAssignments.userId, Number(user.id)));
  const today = new Date().toISOString().slice(0, 10);
  for (const g of rows) {
    if (g.isActive === false) continue;
    if (g.validUntil && String(g.validUntil) < today) continue;
    const bid = Number(g.businessId);
    if (map[bid] === null) continue; // already unrestricted
    if (g.sections === null || g.sections === undefined) map[bid] = null;
    else {
      const cur = map[bid] || [];
      map[bid] = [...new Set([...cur, ...(g.sections as string[]).map(String)])];
    }
  }
  return map;
}

/** Resolve the acting user from the session cookie. Returns null if unauthenticated. */
export async function getSessionInfo(request: Request): Promise<SessionInfo | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = sha256(token);

  // ── Session resolution micro-cache ─────────────────────────────────────
  // Every authenticated API call used to pay TWO sequential DB round trips
  // (session+user join, then org memberships) before doing any real work — a
  // fixed ~2×RTT tax on EVERY request on a remote (deployed) database. The
  // lookup is now ONE query (memberships aggregated server-side via jsonb)
  // and the resolved result is memoised for a few seconds per token, so the
  // natural request burst after a page load (init + heartbeat + notifications
  // + module reads) shares a single lookup instead of repeating it.
  // Correctness: logout / revocation / user-mutation routes call
  // bustSessionCache() in THIS process; on other serverless instances an
  // entry lives at most SESSION_CACHE_TTL_MS (5 s) — the idle-timeout and
  // absolute-expiry checks still run against the cached timestamps, and the
  // 24 h idle policy is unaffected by a 5 s window.
  const cached = sessionCacheGet(tokenHash);
  if (cached !== undefined) return cached.info;

  const res = (await db.execute(sql`
    SELECT to_jsonb(s) AS "__session", to_jsonb(u) AS "__user",
      COALESCE((
        SELECT json_agg(jsonb_build_object('organizationId', m.organization_id, 'isPrimary', m.is_primary, 'status', o.status))
        FROM organization_members m
        LEFT JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = u.id
      ), '[]'::json) AS "__memberships"
    FROM user_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.ended_at IS NULL
  `)) as any;
  const rawRow: any = res?.rows?.[0];
  if (!rawRow) {
    return sessionCachePut(tokenHash, null), null;
  }
  const sessionRow = mapRawRow(userSessions, rawRow.__session);
  const userRow = mapRawRow(users, rawRow.__user);
  const membershipRows: any[] = Array.isArray(rawRow.__memberships) ? rawRow.__memberships : [];
  const row = { session: sessionRow, user: userRow };
  const now = new Date();
  if (row.session.expiresAt && new Date(row.session.expiresAt) < now) {
    await db
      .update(userSessions)
      .set({ endedAt: new Date(), endReason: "EXPIRED" })
      .where(eq(userSessions.id, row.session.id));
    return sessionCachePut(tokenHash, null), null;
  }
  if (row.user.isActive === false) return sessionCachePut(tokenHash, null), null;
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
    return sessionCachePut(tokenHash, null), null;
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
    if (!hasActiveOrg) return sessionCachePut(tokenHash, null), null;
  }
  const user = {
    ...row.user,
    isSuperAdmin: superAdmin,
    organizationIds: orgIds,
    orgId: primaryOrgId,
  };
  const info: SessionInfo = { sessionId: row.session.id, user, orgId: primaryOrgId, orgIds, isSuperAdmin: superAdmin };
  return sessionCachePut(tokenHash, info), info;
}

// ── micro-cache plumbing ─────────────────────────────────────────────────
const SESSION_CACHE_TTL_MS = 5_000;
const g = globalThis as typeof globalThis & { __gominaSessionCache?: Map<string, { info: SessionInfo | null; expiresAt: number }> };
const sessionCache: Map<string, { info: SessionInfo | null; expiresAt: number }> =
  g.__gominaSessionCache ?? (g.__gominaSessionCache = new Map());

function sessionCacheGet(tokenHash: string): { info: SessionInfo | null } | undefined {
  const hit = sessionCache.get(tokenHash);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    sessionCache.delete(tokenHash);
    return undefined;
  }
  return hit;
}

function sessionCachePut(tokenHash: string, info: SessionInfo | null): { info: SessionInfo | null } {
  // opportunistic sweep — the map is tiny (one entry per active viewer)
  if (sessionCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of sessionCache) if (v.expiresAt < now) sessionCache.delete(k);
  }
  const entry = { info, expiresAt: Date.now() + SESSION_CACHE_TTL_MS };
  sessionCache.set(tokenHash, entry);
  return entry;
}

/** Drop memoised session resolutions (logout, revocation, user/org mutations).
 *  Other serverless instances re-resolve within SESSION_CACHE_TTL_MS. */
export function bustSessionCache(): void {
  sessionCache.clear();
}

/** Business ids a user may access. Returns null ⇒ unrestricted (Super Admin).
 *  Org OWNER ⇒ every business of their organization(s). Everyone else ⇒
 *  primary assignment ∪ extra-access grants ∪ managed units, always
 *  intersected with their own organization(s).
 *  `precomputedOrgIds` (from the session resolution) skips the membership
 *  re-read; the two remaining reads always run in ONE parallel wave. */
export async function accessibleBusinessIds(user: any, precomputedOrgIds?: number[]): Promise<number[] | null> {
  if (!user) return [];
  if (isSuperAdmin(user)) return null; // platform-unrestricted
  const orgIds =
    precomputedOrgIds && precomputedOrgIds.length
      ? precomputedOrgIds
      : Array.isArray(precomputedOrgIds)
        ? [] // explicit empty list ⇒ org-less user, skip the re-read
        : await resolveUserOrgIds(user);
  if (user.role === "OWNER") return businessIdsOfOrgs(orgIds); // org-scoped, never global
  // FARM_ADVISOR: access flows ONLY through active, unexpired OWNER grants
  // (advisor_assignments). Primary assignment, extra-access grants and
  // manage-delegations never apply to the external advisor role — revoking
  // or expiring the assignment removes every trace of access at once.
  if (isFarmAdvisor(user)) {
    const grants = await db
      .select({ businessId: advisorAssignments.businessId, isActive: advisorAssignments.isActive, validUntil: advisorAssignments.validUntil })
      .from(advisorAssignments)
      .where(eq(advisorAssignments.userId, user.id));
    const today = new Date().toISOString().slice(0, 10);
    const ids = new Set<number>();
    for (const g of grants) {
      if (g.isActive === false) continue;
      if (g.validUntil && String(g.validUntil) < today) continue; // expired == revoked
      ids.add(Number(g.businessId));
    }
    if (orgIds.length === 0) return [...ids];
    const orgBiz = new Set(await businessIdsOfOrgs(orgIds));
    return [...ids].filter((id) => orgBiz.has(id));
  }
  const ids = new Set<number>();
  if (user.assignedBusinessId) ids.add(Number(user.assignedBusinessId));
  for (const m of businessManageIdsOf(user)) ids.add(m); // manage ⇒ access
  // Grants and org-business reads are independent — one parallel wave.
  const [orgBizIds, grants] = await Promise.all([
    businessIdsOfOrgs(orgIds),
    db
      .select({ businessId: userBusinessAccess.businessId })
      .from(userBusinessAccess)
      .where(eq(userBusinessAccess.userId, user.id)),
  ]);
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
