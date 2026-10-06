/**
 * organizationProvisioning — the ONE place that creates a new platform Owner
 * workspace (organization + OWNER user + membership + settings + audit trail).
 *
 * Extracted from `POST /api/admin/organizations` so that the Platform Owners
 * console AND the approval of a `platform_requests` row go through exactly the
 * same, already-tested routine. Duplicating this logic would mean two subtly
 * different definitions of "provision an Owner" — the classic way an approval
 * workflow drifts from the manual one.
 *
 * SERVER-ONLY. Callers must have established the Super Admin actor themselves
 * (`requireSuperAdmin`) — this module performs no authorization of its own.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, organizationMembers, users, companySettings, auditTrail, platformRequests } from "@/db/schema";
import { setUserPassword } from "@/lib/auth";
import { ttlInvalidate } from "@/lib/ttlCache";

export type ProvisionInput = {
  /** Organization / business-group name (required). */
  name: string;
  /** Owner's full name (required). */
  ownerName: string;
  /** Owner's globally-unique sign-in email (required, lower-cased here). */
  ownerEmail: string;
  /** Optional owner phone; defaults to a placeholder like the console does. */
  ownerPhone?: string | null;
  /** Optional organisation contact phone. */
  contactPhone?: string | null;
  /** Explicit initial password; a random one is generated when omitted. */
  ownerPassword?: string | null;
};

/** Thrown for caller-correctable problems ⇒ mapped to a 4xx by the routes. */
export class ProvisionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "ProvisionError";
  }
}

export type ProvisionResult = {
  organization: { id: number; name: string; slug: string; status: string };
  owner: { id: number; name: string; email: string; role: string };
  /** Returned ONCE — the caller must hand it over and must never persist it. */
  initialPassword: string;
};

const ROLE_LEVEL = "OWNER";

/**
 * Create a fully-isolated Owner workspace. Idempotent only in the sense that a
 * duplicate email is refused up-front with a 409 — it never silently reuses an
 * existing account (that would hand a stranger someone else's login).
 */
export async function provisionOrganization(actor: any, input: ProvisionInput): Promise<ProvisionResult> {
  const name = String(input.name || "").trim().slice(0, 160);
  const ownerName = String(input.ownerName || "").trim().slice(0, 120);
  const ownerEmail = String(input.ownerEmail || "").trim().toLowerCase().slice(0, 160);
  const ownerPhone = String(input.ownerPhone || "").trim().slice(0, 60) || "+233 24 000 0000";
  const contactPhone = String(input.contactPhone || "").trim().slice(0, 60) || null;

  if (!name || !ownerName || !ownerEmail) {
    throw new ProvisionError("Organization name, owner name and owner email are required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new ProvisionError("That owner email does not look valid.");
  }

  // Globally-unique login identity (product decision D3).
  const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail));
  if (dupe) {
    throw new ProvisionError("A user with this email already exists.", 409);
  }

  // Slug: derived from the name, unique-safe for future per-owner storefronts.
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "org";
  let slug = baseSlug;
  for (let i = 2; ; i++) {
    const [taken] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    if (!taken) break;
    slug = `${baseSlug}-${i}`;
  }

  const initialPassword =
    String(input.ownerPassword || "").trim() || `GoMina-${Math.random().toString(36).slice(2, 10)}`;

  // ALL writes happen in ONE transaction: a workspace must never be left half
  // built (an organization without its Owner, or an organization whose settings
  // row failed) — a partial provision is an orphan account nobody can sign in
  // to, and if it is reached from a registration request the request is stuck
  // forever. Either the whole workspace lands, or nothing does.
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          name,
          slug,
          status: "ACTIVE",
          contactEmail: ownerEmail,
          contactPhone,
          createdByUserId: actor.id,
        })
        .returning();

      const [owner] = await tx
        .insert(users)
        .values({
          name: ownerName,
          email: ownerEmail,
          role: ROLE_LEVEL,
          assignedBusinessId: null,
          phone: ownerPhone,
          isActive: true,
          isWorkerEnabled: true,
          createdByUserId: actor.id,
          canRecordSales: true,
          canExportData: true,
          isSuperAdmin: false,
          primaryOrgId: org.id,
        })
        .returning();

      await setUserPassword(owner.id, initialPassword, tx);

      await tx.insert(organizationMembers).values({
        organizationId: org.id,
        userId: owner.id,
        roleInOrg: "OWNER",
        isPrimary: true,
      });
      await tx
        .update(organizations)
        .set({ ownerUserId: owner.id, updatedAt: new Date() })
        .where(eq(organizations.id, org.id));

      // Clean workspace: per-org settings row (no logo — the Owner uploads
      // theirs). organization_id is UNIQUE, and databases that predate the
      // forward-only sequence repair (dev-tooling/seq-realign.mjs) can still
      // carry a settings row left behind by a deleted organization whose id was
      // later reused — that stale row must never abort a new workspace.
      await tx
        .insert(companySettings)
        .values({
          organizationId: org.id,
          updatedByUserId: actor.id,
          updatedByName: actor.name,
          updatedByRole: actor.role,
        })
        .onConflictDoNothing({ target: companySettings.organizationId });

      return {
        organization: { id: org.id, name: org.name, slug: org.slug, status: org.status },
        owner: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
        initialPassword,
      };
    });
  } catch (e: any) {
    // The uniqueness pre-checks above are advisory (they run outside the
    // transaction), so a concurrent create can still lose the race on
    // users.email. Report that as the same 409 the pre-check would have given
    // instead of a 500 — the transaction has already rolled everything back.
    const code = e?.code || e?.cause?.code;
    if (code === "23505") {
      throw new ProvisionError("A user with this email already exists.", 409);
    }
    throw e;
  }
}

/**
 * Immutable platform-level audit row. `targetType` is free text in the trail
 * and `ownerId` is nullable, so platform events are recorded with
 * `ownerId: null` — they must never be attributed to a tenant.
 */
export async function writePlatformTrail(
  actor: any,
  action: string,
  targetType: string,
  targetLabel: string,
  detail: string,
  ownerId: number | null = null,
) {
  await db.insert(auditTrail).values({
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    targetType,
    targetLabel,
    detail,
    // NO `?? actor.orgId` fallback here — deliberately. A platform event
    // belongs to no tenant, so it is recorded with ownerId = null and can
    // never be attributed to (or leak into) whichever organisation the acting
    // Super Admin happened to be viewing. (The tenant-scoped `writeAdminTrail`
    // in the organizations route keeps its own fallback.)
    ownerId: ownerId ?? null,
  });
}

/** Public caches that depend on organizations/businesses must be dropped. */
export function invalidatePublicCaches() {
  ttlInvalidate("menu");
  ttlInvalidate("init");
}

/**
 * Recovery for a PARTIALLY-COMPLETED provisioning attempt.
 *
 * The console/approval flow performs two writes that cannot share a
 * transaction across the HTTP boundary: `provisionOrganization()` creates the
 * workspace, then the caller stamps `platform_requests` and writes the audit
 * row. If the process dies — or any later step throws — between them, the
 * account exists but the request is never marked, and every retry then hits the
 * globally-unique-email rule and fails with 409 forever. The operator is left
 * with an orphan organization and no way to reconcile it.
 *
 * This helper finds that orphan so a retry can ADOPT it instead of colliding.
 *
 * Deliberately narrow, so adoption can never link an applicant to somebody
 * else's pre-existing account:
 *   • the user's email must match exactly (case-insensitive),
 *   • the account and its organization must both have been created AFTER the
 *     request arrived,
 *   • the organization must not already be claimed by another platform request.
 */
export async function findProvisionedWorkspaceForRecovery(
  email: string | null | undefined,
  since: Date | string | null | undefined,
): Promise<{ organization: { id: number; name: string; slug: string; status: string }; owner: { id: number; name: string; email: string; role: string } } | null> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const sinceDate = since ? new Date(since) : null;
  if (!sinceDate || Number.isNaN(sinceDate.getTime())) return null;

  const [owner] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isSuperAdmin: users.isSuperAdmin,
      primaryOrgId: users.primaryOrgId,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (!owner || owner.isSuperAdmin) return null;
  if (owner.createdAt && new Date(owner.createdAt) < sinceDate) return null; // pre-existing account — never adopt
  if (owner.primaryOrgId == null) return null;

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, status: organizations.status, createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, Number(owner.primaryOrgId)))
    .limit(1);
  if (!org) return null;
  if (org.createdAt && new Date(org.createdAt) < sinceDate) return null;

  // Never steal a workspace another request already owns.
  const [claimed] = await db
    .select({ id: platformRequests.id })
    .from(platformRequests)
    .where(eq(platformRequests.createdOrganizationId, org.id))
    .limit(1);

  return {
    organization: { id: org.id, name: org.name, slug: org.slug, status: org.status },
    owner: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
    // internal: is this org already stamped on another request?
    ...(claimed ? { __claimedByRequestId: claimed.id } : {}),
  } as any;
}
