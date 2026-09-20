import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  organizations,
  organizationMembers,
  organizationBusinessTypes,
  businesses,
  users,
  userSessions,
  auditTrail,
  companySettings,
} from "@/db/schema";
import { desc, eq, inArray, and, sql } from "drizzle-orm";
import { BUSINESS_TYPES, businessTypeKeyOf, businessTypeLabelOf } from "@/lib/businessTypes";
import { ttlInvalidate } from "@/lib/ttlCache";
import {
  requireSuperAdmin,
  getSessionInfo,
  setUserPassword,
  UNAUTHENTICATED,
  FORBIDDEN,
} from "@/lib/auth";
import { apiError } from "@/lib/apiError";

/**
 * Platform-level organization (Owner) lifecycle — SUPER ADMIN ONLY.
 *
 * GET    → every organization with owner, member and business counts.
 * POST   → provision a NEW independent Owner: organization + OWNER member +
 *          clean workspace (no demo data) + per-org company settings row.
 *          Returns the generated initial password ONCE.
 * PATCH  → rename; SUSPEND / ACTIVATE (reactivate suspended, or RESTORE a
 *          deleted org — suspending ends every live member session at once);
 *          DELETE_ORGANIZATION (typed-name confirm) — permanently revokes the
 *          Owner's platform access (accounts deactivated, sessions ended)
 *          while preserving ALL of their data and configuration, restorable;
 *          SET/GRANT/REVOKE/UNRESTRICT_BUSINESS_TYPES — allowed business types.
 * Every mutation is written to the immutable audit trail.
 */

const ROLE_LEVEL = "OWNER";

async function writeAdminTrail(actor: any, action: string, targetLabel: string, detail: string, ownerId: number | null) {
  await db.insert(auditTrail).values({
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    targetType: "ORGANIZATION",
    targetLabel,
    detail,
    ownerId: ownerId ?? actor.orgId ?? null,
  });
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    if (!session.user.isSuperAdmin) return FORBIDDEN("Only the platform Super Admin can manage organizations.");

    const [orgRows, memberRows, typeRows, bizRows, userRows] = await Promise.all([
      db.select().from(organizations).orderBy(organizations.id),
      db.select().from(organizationMembers),
      db.select().from(organizationBusinessTypes),
      db
        .select({ ownerId: businesses.ownerId, cnt: sql<number>`count(*)::int` })
        .from(businesses)
        .groupBy(businesses.ownerId),
      db.select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive }).from(users),
    ]);
    const bizCount = new Map(bizRows.map((b) => [Number(b.ownerId), Number(b.cnt)]));
    const userById = new Map(userRows.map((u) => [Number(u.id), u]));

    const directory = orgRows.map((o) => {
      const members = memberRows.filter((m) => Number(m.organizationId) === o.id);
      const owners = members
        .filter((m) => m.roleInOrg === "OWNER")
        .map((m) => {
          const u = userById.get(Number(m.userId));
          return u ? { id: u.id, name: u.name, email: u.email, isActive: u.isActive } : null;
        })
        .filter(Boolean);
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        status: o.status,
        contactEmail: o.contactEmail,
        contactPhone: o.contactPhone,
        createdAt: o.createdAt,
        owners,
        memberCount: members.length,
        businessCount: bizCount.get(o.id) || 0,
        // Allowed Business Types (Super-Admin-managed)
        businessTypesRestricted: o.businessTypesRestricted === true,
        allowedBusinessTypes: typeRows
          .filter((t) => Number(t.organizationId) === o.id)
          .map((t) => ({ key: t.businessTypeKey, label: businessTypeLabelOf(t.businessTypeKey) })),
      };
    });
    return NextResponse.json({
      success: true,
      organizations: directory,
      // the full catalogue the Super Admin can grant/revoke
      businessTypeOptions: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  try {
    const actor = await requireSuperAdmin(request);
    if (!actor) return FORBIDDEN("Only the platform Super Admin can create organizations.");

    const body = await request.json();
    const name = String(body.name || "").trim().slice(0, 160);
    const ownerName = String(body.ownerName || "").trim().slice(0, 120);
    const ownerEmail = String(body.ownerEmail || "").trim().toLowerCase().slice(0, 160);
    const ownerPhone = String(body.ownerPhone || "").trim().slice(0, 60) || "+233 24 000 0000";
    const contactPhone = String(body.contactPhone || "").trim().slice(0, 60) || null;
    if (!name || !ownerName || !ownerEmail) {
      return NextResponse.json(
        { success: false, error: "Organization name, owner name and owner email are required." },
        { status: 400 },
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return NextResponse.json({ success: false, error: "That owner email does not look valid." }, { status: 400 });
    }

    // Globally-unique login identity (product decision D3).
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail));
    if (dupe) {
      return NextResponse.json(
        { success: false, error: "A user with this email already exists." },
        { status: 409 },
      );
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

    const [org] = await db
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

    const [owner] = await db
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

    const initialPassword = String(body.ownerPassword || "").trim() || `GoMina-${Math.random().toString(36).slice(2, 10)}`;
    await setUserPassword(owner.id, initialPassword);

    await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId: owner.id,
      roleInOrg: "OWNER",
      isPrimary: true,
    });
    await db.update(organizations).set({ ownerUserId: owner.id, updatedAt: new Date() }).where(eq(organizations.id, org.id));

    // Clean workspace: per-org settings row (no logo — the Owner uploads theirs).
    await db.insert(companySettings).values({
      organizationId: org.id,
      updatedByUserId: actor.id,
      updatedByName: actor.name,
      updatedByRole: actor.role,
    });

    await writeAdminTrail(
      actor,
      "CREATE_ORGANIZATION",
      `${name} (#${org.id})`,
      `Provisioned organization "${name}" (${slug}) with OWNER ${ownerName} <${ownerEmail}> (user #${owner.id}).`,
      org.id,
    );

    return NextResponse.json({
      success: true,
      organization: { id: org.id, name: org.name, slug: org.slug, status: org.status },
      owner: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
      initialPassword, // returned ONCE — hand it to the new Owner securely
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  try {
    const actor = await requireSuperAdmin(request);
    if (!actor) return FORBIDDEN("Only the platform Super Admin can manage organizations.");

    const body = await request.json();
    const id = Number(body.id);
    if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });

    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    if (!org) return NextResponse.json({ success: false, error: "Organization not found" }, { status: 404 });

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      const n = String(body.name).trim().slice(0, 160);
      if (!n) return NextResponse.json({ success: false, error: "Name cannot be empty." }, { status: 400 });
      updates.name = n;
    }
    if (body.contactEmail !== undefined) updates.contactEmail = body.contactEmail ? String(body.contactEmail).slice(0, 160) : null;
    if (body.contactPhone !== undefined) updates.contactPhone = body.contactPhone ? String(body.contactPhone).slice(0, 60) : null;

    const action = String(body.action || "").toUpperCase();
    if (action === "SUSPEND" || action === "ACTIVATE") {
      updates.status = action === "SUSPEND" ? "SUSPENDED" : "ACTIVE";
    }
    // ── DELETE — permanently revoke the Owner's platform access while
    // preserving ALL of their data and configuration. Soft-remove: the
    // organization row, businesses, users, stock, money, ledgers, settings
    // and allowed business types all stay intact (and the Super Admin can
    // RESTORE the workspace with ACTIVATE). Every member account is
    // deactivated and all live sessions are ended at once.
    if (action === "DELETE_ORGANIZATION") {
      if (id === 1) {
        return NextResponse.json(
          { success: false, error: "The main Owner workspace cannot be deleted." },
          { status: 400 },
        );
      }
      if (String(body.confirmName || "").trim() !== org.name) {
        return NextResponse.json(
          { success: false, error: `Type the organization name "${org.name}" to confirm deletion.` },
          { status: 400 },
        );
      }
      if ((org.status || "").toUpperCase() !== "DELETED") {
        updates.status = "DELETED";
      }
    }

    // ── Allowed Business Types management (Main Owner / Super Admin only) ──
    const TYPES_ACTIONS = new Set([
      "GRANT_BUSINESS_TYPE",
      "REVOKE_BUSINESS_TYPE",
      "SET_BUSINESS_TYPES",
      "UNRESTRICT_BUSINESS_TYPES",
    ]);
    let typesDetail: string | null = null;
    if (TYPES_ACTIONS.has(action)) {
      if (id === 1) {
        return NextResponse.json(
          { success: false, error: "The main workspace always keeps full access to every business type." },
          { status: 400 },
        );
      }
      if (action === "SET_BUSINESS_TYPES" || action === "GRANT_BUSINESS_TYPE" || action === "REVOKE_BUSINESS_TYPE") {
        const rawKeys: string[] = Array.isArray(body.businessTypeKeys)
          ? body.businessTypeKeys.map((k: any) => businessTypeKeyOf(String(k)))
          : body.businessTypeKey !== undefined
            ? [businessTypeKeyOf(String(body.businessTypeKey))]
            : [];
        if (rawKeys.length === 0 && action !== "SET_BUSINESS_TYPES") {
          return NextResponse.json({ success: false, error: "businessTypeKey(s) required" }, { status: 400 });
        }
        if (action === "SET_BUSINESS_TYPES") {
          await db.delete(organizationBusinessTypes).where(eq(organizationBusinessTypes.organizationId, id));
          for (const key of new Set(rawKeys)) {
            await db.insert(organizationBusinessTypes).values({
              organizationId: id,
              businessTypeKey: key,
              createdByUserId: actor.id,
            });
          }
          updates.businessTypesRestricted = true;
          typesDetail =
            rawKeys.length > 0
              ? `Allowed Business Types set to: ${rawKeys.map((k) => businessTypeLabelOf(k)).join(", ")}. Existing businesses are unaffected; new creations of other types are refused.`
              : "All business-type grants revoked; the Owner can no longer create new business units until the Super Admin grants a type. Existing businesses are unaffected.";
        } else if (action === "GRANT_BUSINESS_TYPE") {
          const key = rawKeys[0];
          const existing = await db
            .select({ id: organizationBusinessTypes.id })
            .from(organizationBusinessTypes)
            .where(and(eq(organizationBusinessTypes.organizationId, id), eq(organizationBusinessTypes.businessTypeKey, key)));
          if (!existing.length) {
            await db.insert(organizationBusinessTypes).values({
              organizationId: id,
              businessTypeKey: key,
              createdByUserId: actor.id,
            });
          }
          updates.businessTypesRestricted = true;
          typesDetail = `Granted business type "${businessTypeLabelOf(key)}".`;
        } else {
          // REVOKE — only the grant row is removed; every existing business of
          // that type stays fully owned and operable (revocation gates NEW
          // creation only, by design).
          const key = rawKeys[0];
          await db
            .delete(organizationBusinessTypes)
            .where(and(eq(organizationBusinessTypes.organizationId, id), eq(organizationBusinessTypes.businessTypeKey, key)));
          typesDetail = `Revoked business type "${businessTypeLabelOf(key)}" — existing units of that type keep working; only new creation is refused.`;
        }
      } else if (action === "UNRESTRICT_BUSINESS_TYPES") {
        await db.delete(organizationBusinessTypes).where(eq(organizationBusinessTypes.organizationId, id));
        updates.businessTypesRestricted = false;
        typesDetail = "Business-type restriction removed — the Owner may create every current and future business type.";
      }
    }

    await db.update(organizations).set(updates).where(eq(organizations.id, id));

    if (action === "SUSPEND" || action === "DELETE_ORGANIZATION") {
      // Immediately sign out every member of the suspended/removed organization.
      const memberRows = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, id));
      const memberIds = memberRows.map((m) => Number(m.userId));
      if (memberIds.length) {
        await db
          .update(userSessions)
          .set({ endedAt: new Date(), endReason: action === "SUSPEND" ? "ORG_SUSPENDED" : "ORG_DELETED" })
          .where(inArray(userSessions.userId, memberIds));
      }
      if (action === "DELETE_ORGANIZATION" && memberIds.length) {
        // Deactivate every member account — platform access fully revoked.
        // Their user ROWS (and all org data) stay untouched, so a RESTORE
        // brings every account back with the same roles & settings.
        await db.update(users).set({ isActive: false }).where(inArray(users.id, memberIds));
      }
    }
    if (action === "ACTIVATE") {
      // Restore member accounts on reactivation/restoration (data, roles and
      // settings were never touched by suspension or deletion).
      const memberRows = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, id));
      const memberIds = memberRows.map((m) => Number(m.userId));
      if (memberIds.length) {
        await db.update(users).set({ isActive: true }).where(inArray(users.id, memberIds));
      }
    }

    await writeAdminTrail(
      actor,
      action === "SUSPEND"
        ? "SUSPEND_ORGANIZATION"
        : action === "ACTIVATE"
          ? org.status === "DELETED"
            ? "RESTORE_ORGANIZATION"
            : "ACTIVATE_ORGANIZATION"
          : action === "DELETE_ORGANIZATION"
            ? "DELETE_ORGANIZATION"
            : typesDetail
              ? action
              : "UPDATE_ORGANIZATION",
      `${org.name} (#${org.id})`,
      typesDetail ??
        (action === "SUSPEND"
          ? `Organization suspended; all member sessions ended. Data and settings fully preserved.`
          : action === "ACTIVATE"
            ? org.status === "DELETED"
              ? `Deleted organization restored; member accounts reactivated. All preserved data and access settings are back in place.`
              : `Organization reactivated.`
            : action === "DELETE_ORGANIZATION"
              ? `Organization deleted by ${actor.name}: platform access revoked for all members, sessions ended, accounts deactivated. ALL data (businesses, users, customers, stock, money, ledgers, settings, allowed business types) preserved for compliance/restore.`
              : `Organization details updated.`),
      id,
    );

    const [fresh] = await db.select().from(organizations).where(eq(organizations.id, id));
    return NextResponse.json({ success: true, organization: fresh });
  } catch (error: any) {
    return apiError(error);
  }
}
