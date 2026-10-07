import { NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { batchReads } from "@/lib/batchRead";
import { users, businesses, userSessions, userBusinessAccess, auditTrail, organizationMembers, advisorAssignments, notifications, pushSubscriptions } from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  usersAccessMap,
  setUserPassword,
  replaceUserAccess,
  sharesOrganization,
  FORBIDDEN,
  UNAUTHENTICATED,
  bustSessionCache,
} from "@/lib/auth";

/** May this caller see/pick `targetUserRow`? Super Admin ⇒ anyone; everyone
 *  else ⇒ only users sharing an organization (users with NO membership are
 *  legacy orphans — visible to executives only via business-scope checks). */
import { backfillUserNotifications, businessIdsForUser } from "@/lib/notify";
import crypto from "crypto";
import { apiError } from "@/lib/apiError";
import { auditEvent } from "@/lib/audit";
import { canSeeEnterpriseUsers } from "@/lib/permissions";
import { validateOptionalImage } from "@/lib/mediaValidation";
import { cachedJson } from "@/lib/httpCache";
import {
  CAPABILITIES,
  normaliseRole,
  canAssignRole,
  canActOnRole,
  roleDef,
  roleLabel,
  rolePreset,
  inRoleGroup,
  isDelegateUserManager,
  type CapabilityKey,
} from "@/lib/roles";

const stripSecret = (u: any) => {
  const {
    passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe
  } = u;
  return { ...safe, hasPassword: Boolean(u.passwordHash) };
};

/** Normalize a client-supplied list of business ids (manage grants). */
const cleanIdList = (v: any): number[] =>
  Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    // ENTERPRISE USERS SURFACE — restricted to the OWNER, the platform Super
    // Admin and accounts the OWNER explicitly authorised (`canManageUsers`).
    // A GENERAL_MANAGER role alone does NOT open the staff directory.
    if (!canSeeEnterpriseUsers(me)) {
      return FORBIDDEN(
        "Enterprise Users is restricted to the OWNER and the users the OWNER authorises. Ask the OWNER for access."
      );
    }
    const isExec = inRoleGroup("EXECUTIVE", me.role);
    const fullDirectory = isExec || me.isSuperAdmin;
    const allowed = await accessibleBusinessIds(me);

    // ONE round trip for the page's base read (see src/lib/batchRead.ts).
    const U = await batchReads([{ key: "users", table: users, order: "id", scope: "none" }]);
    let rows = U.users;
    if (!fullDirectory) {
      // Delegated (non-executive) Enterprise Users administrators see ONLY the
      // people inside the units they manage — never the whole organisation.
      rows = rows.filter(
        (u) => u.id === me.id || (u.assignedBusinessId != null && (allowed ?? []).includes(Number(u.assignedBusinessId)))
      );
    } else if (!me.isSuperAdmin) {
      // Executives see the full user directory of THEIR OWN organization(s)
      // only — never another Owner's people.
      const myOrgs = me.organizationIds?.length ? me.organizationIds : [-1];
      const memberRows = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, myOrgs));
      const memberIds = new Set(memberRows.map((m) => Number(m.userId)));
      rows = rows.filter((u) => u.id === me.id || memberIds.has(u.id));
    }
    if (!isExec) {
      rows = rows.filter(
        (u) =>
          u.id === me.id ||
          (u.assignedBusinessId != null && (allowed ?? []).includes(Number(u.assignedBusinessId)))
      );
    }

    const accessMap = await usersAccessMap(rows.map((u) => u.id));
    return cachedJson(request, {
      success: true,
      users: rows.map((u) => ({ ...stripSecret(u), extraAccessIds: accessMap[u.id] || [] })),
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json();
    const {
      name,
      email,
      role: roleRaw,
      assignedBusinessId,
      phone,
      avatarUrl,
      region,
      district,
      town,
      canRecordSales,
      canRecordExpenses,
      canManageStock,
      canExportData,
      canManageRecords,
      canDeleteInventory,
      canManageExpenses,
      canManageUsers,
      canManageCctv,
      canManageAuditors,
      canManageOnline,
      canCreateBusiness,
      canViewFinance,
      canManageSupport,
      password,
      extraAccessIds,
      businessManageIds,
    } = body;

    // A data-URL avatar (Users & Access upload) is validated centrally; the
    // default remote Unsplash URL passes through untouched.
    if (typeof avatarUrl === "string" && avatarUrl.startsWith("data:")) {
      const avatarCheck = validateOptionalImage(avatarUrl, "avatar", { label: "Avatar" });
      if (!avatarCheck.ok) return NextResponse.json({ success: false, error: avatarCheck.error }, { status: 400 });
    }
    const avatarValue = typeof avatarUrl === "string" && avatarUrl.startsWith("data:") ? avatarUrl : (avatarUrl || null);

    if (!name || !email || !roleRaw) {
      return NextResponse.json(
        { success: false, error: "Name, email, and role are required" },
        { status: 400 }
      );
    }
    // ROLE VALIDATION — the registry is now the only door. Before this any
    // string was accepted: `role: "BANANA"` cleared every check and created an
    // account matching no code path (docs/ROLES-AND-PERMISSIONS-AUDIT.md F2).
    const roleKey = normaliseRole(roleRaw);
    if (!roleKey) {
      return NextResponse.json(
        { success: false, error: `Unknown role "${String(roleRaw).slice(0, 40)}". Pick a role from the list.` },
        { status: 400 },
      );
    }
    if (!canAssignRole(me, roleKey)) {
      return FORBIDDEN(`You are not authorised to create ${roleLabel(roleKey)} accounts.`);
    }
    // From here on `role` is the canonical, validated key — every downstream
    // comparison and every stored value uses it.
    const role = roleKey;

    const isOwner = me.role === "OWNER";
    const isBranchManager = me.role === "BRANCH_MANAGER";
    // OWNER-delegated user administrator: manager (branch or general) trusted
    // to run Users & Access strictly within the branches they can access.
    const isDelegatedMgr = isDelegateUserManager(me);
    // CAPABILITY PRESETS — the role registry is the single source of truth for
    // what a role starts with (docs/ROLES-AND-PERMISSIONS-AUDIT.md §7.3). An
    // explicit value from the caller wins; otherwise the role's preset applies.
    // Farm Advisors can never hold a capability (read-only by construction) and
    // the OWNER-only surfaces stay owner-only.
    const preset = rolePreset(role);
    const cap = (sent: any, key: CapabilityKey): boolean =>
      sent !== undefined ? Boolean(sent) : preset[key] === true;
    const capOwner = (sent: any, key: CapabilityKey): boolean => (isOwner ? cap(sent, key) : false);
    // ── Farm Advisor accounts ─────────────────────────────────────────────
    // External advisors are onboarded by the OWNER only. They never carry a
    // primary branch assignment or any management power — their entire access
    // flows through advisor_assignments, granted separately (see /api/advisor).
    const isAdvisor = role === "FARM_ADVISOR";
    if (isAdvisor && !isOwner) {
      return FORBIDDEN("Only the OWNER can create Farm Advisor accounts.");
    }
    if (!isOwner) {
      const allowed = await accessibleBusinessIds(me);
      if (isDelegatedMgr) {
        // Delegated managers create WORKERS and BRANCH MANAGERS only, always
        // pinned to a branch inside their own scope; extra grants are capped
        // at that same scope. They can never mint elevated roles, hand out
        // record-management, or extend the delegation itself.
        // Registry-owned (D5): a delegate may mint exactly the roles flagged
        // OWNER_OR_DELEGATE — Branch Manager and Worker — and nothing else.
        if (roleDef(role)?.assignableBy !== "OWNER_OR_DELEGATE") {
          return FORBIDDEN("You can only create Worker and Branch Manager accounts.");
        }
        if (!assignedBusinessId || !(allowed ?? []).includes(Number(assignedBusinessId))) {
          return FORBIDDEN("You can only create users for branches you manage.");
        }
        if (canManageUsers) {
          return FORBIDDEN("Only the OWNER can delegate user management.");
        }
        if (Array.isArray(extraAccessIds) && extraAccessIds.some((id: any) => !(allowed ?? []).includes(Number(id)))) {
          return FORBIDDEN("You can only grant access to branches you manage.");
        }
      } else {
        // Legacy: a plain branch manager may ONLY create WORKER accounts for a
        // business they themselves can access. An executive (GM / co-owner)
        // without the OWNER's Enterprise Users authorisation creates nothing.
        if (!isBranchManager || role !== "WORKER") {
          return FORBIDDEN("Only the OWNER can create user accounts.");
        }
        if (!assignedBusinessId || !(allowed ?? []).includes(Number(assignedBusinessId))) {
          return FORBIDDEN("You can only create workers for your own business.");
        }
      }
    }

    // A primary unit / extra-access grant must point at a real business. Without
    // this, any caller could park an account on a non-existent branch id — a
    // broken account, and a way to probe ids across the boundary.
    const allBusinessIds = new Set(
      (await db.select({ id: businesses.id }).from(businesses)).map((b: { id: number }) => Number(b.id)),
    );
    if (assignedBusinessId && !allBusinessIds.has(Number(assignedBusinessId))) {
      return NextResponse.json({ success: false, error: "Unknown business branch." }, { status: 400 });
    }
    if (Array.isArray(extraAccessIds) && extraAccessIds.some((id: any) => !allBusinessIds.has(Number(id)))) {
      return NextResponse.json({ success: false, error: "Unknown business branch in extra access." }, { status: 400 });
    }

    // Org OWNER (not Super Admin): every business the new account touches —
    // primary assignment, extra access grants, manage-grants — must live
    // inside their OWN organization.
    if (isOwner && !me.isSuperAdmin) {
      const orgBiz = new Set(await accessibleBusinessIds(me));
      if (assignedBusinessId && !orgBiz.has(Number(assignedBusinessId))) {
        return FORBIDDEN("You can only assign businesses inside your own organization.");
      }
      if (Array.isArray(extraAccessIds) && extraAccessIds.some((id: any) => !orgBiz.has(Number(id)))) {
        return FORBIDDEN("You can only grant access to businesses inside your own organization.");
      }
      if (Array.isArray(businessManageIds) && businessManageIds.some((id: any) => !orgBiz.has(Number(id)))) {
        return FORBIDDEN("You can only delegate Manage Business / Unit powers inside your own organization.");
      }
    }

    // Unit-scoped roles cannot exist without a unit (registry `requiresUnit`) —
    // Worker today, and now Supervisor / Accountant too (audit finding F10).
    if (roleDef(role)?.requiresUnit && !assignedBusinessId) {
      return NextResponse.json(
        { success: false, error: `${role} must be assigned to a business branch` },
        { status: 400 }
      );
    }
    // …and an EXTERNAL advisor must NOT hold one (registry `forbidsUnit`).
    if (roleDef(role)?.forbidsUnit && assignedBusinessId) {
      return NextResponse.json(
        { success: false, error: "Farm Advisors are not assigned to a branch." },
        { status: 400 },
      );
    }

    // canManageRecords is OWNER-granted only (a non-owner merely ECHOING the
    // inherited false default is not a grant — only a truthy value is).
    if (!!canManageRecords && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant record-management permission.");
    }
    // Delete-inventory permission is likewise OWNER-granted only.
    if (!!canDeleteInventory && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant the delete-inventory permission.");
    }
    // Expense-management permission is likewise OWNER-granted only.
    if (!!canManageExpenses && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant the expense-management permission.");
    }
    if (!!canManageCctv && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant CCTV management permission.");
    }
    if (!!canManageAuditors && !isOwner) {
      return FORBIDDEN("Only the OWNER can delegate auditor-access management.");
    }
    if (!!canManageOnline && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant Online Storefront & Delivery Areas management.");
    }
    if (!!canCreateBusiness && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant the New Branch/Unit permission.");
    }
    if (!!canViewFinance && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant Finance & Reports access.");
    }
    if (!!canManageSupport && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant Customer Support (storefront HELP) access.");
    }
    if (Array.isArray(businessManageIds) && businessManageIds.length && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant Manage Business / Unit permission.");
    }
    // Non-OWNER can never create other elevated roles.
    // Every OWNER-only capability comes from the registry — this list used to be
    // hand-written here and had already drifted from the console (audit F3/F4).
    const ownerOnlyAsked = CAPABILITIES.filter((c) => c.ownerOnly).some(
      (c) => (body as any)?.[c.key] === true,
    );
    if (!isOwner && (ownerOnlyAsked || !canAssignRole(me, role))) {
      return FORBIDDEN("Insufficient privilege.");
    }

    // An advisor account never carries management power — not even on the
    // OWNER's request. The role is read-only by construction; its only write
    // surface anywhere in the platform is advisor notes.
    if (
      role === "FARM_ADVISOR" &&
      ([canManageRecords, canDeleteInventory, canManageExpenses, canManageUsers, canManageCctv, canManageAuditors, canManageOnline, canCreateBusiness, canViewFinance, canManageSupport].some(Boolean) ||
        (Array.isArray(businessManageIds) && businessManageIds.length > 0))
    ) {
      return NextResponse.json(
        { success: false, error: "Farm Advisor accounts are read-only by design — management permissions cannot be attached." },
        { status: 400 },
      );
    }

    const emailNorm = String(email).trim().toLowerCase();
    const dupe = await db.select({ id: users.id }).from(users).where(eq(users.email, emailNorm));
    if (dupe.length) {
      return NextResponse.json(
        { success: false, error: "A user with this email already exists." },
        { status: 409 }
      );
    }

    // Initial password: explicitly given or generated (returned once).
    const initialPassword = String(password || "").trim() || `Mina-${crypto.randomBytes(4).toString("hex")}`;

    const [newUser] = await db
      .insert(users)
      .values({
        name,
        email: emailNorm,
        role,
        assignedBusinessId: assignedBusinessId ? Number(assignedBusinessId) : null,
        phone: phone || "+233 24 000 0000",
        avatarUrl:
          avatarValue ||
          "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop",
        region: region || null,
        district: district || null,
        town: town || null,
        isActive: true,
        isWorkerEnabled: role === "WORKER" ? true : undefined,
        createdByUserId: me.id,
        // Tenant: the new user joins the creator's organization.
        primaryOrgId: session.orgId ?? null,
        // The four operational capabilities apply to every staff role (they used
        // to be honoured only for WORKER, so the access console rendered toggles
        // the API silently ignored — audit finding F3).
        canRecordSales: isAdvisor ? false : cap(canRecordSales, "canRecordSales"),
        canRecordExpenses: isAdvisor ? false : cap(canRecordExpenses, "canRecordExpenses"),
        canManageStock: isAdvisor ? false : cap(canManageStock, "canManageStock"),
        canExportData: isAdvisor ? false : cap(canExportData, "canExportData"),
        // OWNER-only sensitive surfaces (server-enforced, unchanged).
        canManageRecords: capOwner(canManageRecords, "canManageRecords"),
        canDeleteInventory: capOwner(canDeleteInventory, "canDeleteInventory"),
        canManageExpenses: capOwner(canManageExpenses, "canManageExpenses"),
        canManageCctv: capOwner(canManageCctv, "canManageCctv"),
        canManageAuditors: capOwner(canManageAuditors, "canManageAuditors"),
        canManageOnline: capOwner(canManageOnline, "canManageOnline"),
        canCreateBusiness: capOwner(canCreateBusiness, "canCreateBusiness"),
        canViewFinance: capOwner(canViewFinance, "canViewFinance"),
        canManageSupport: capOwner(canManageSupport, "canManageSupport"),
        // Manage Business / Unit delegation — OWNER-granted only.
        businessManageIds: isOwner ? cleanIdList(businessManageIds) : [],
        // Delegation flag: OWNER-granted, and only meaningful on the roles the
        // registry marks delegate-eligible (never on Farm Advisors or Workers).
        canManageUsers:
          isOwner && inRoleGroup("DELEGATE_ELIGIBLE", role) ? cap(canManageUsers, "canManageUsers") : false,
      })
      .returning();

    await setUserPassword(newUser.id, initialPassword);
    if (session.orgId != null) {
      await db.insert(organizationMembers).values({
        organizationId: session.orgId,
        userId: newUser.id,
        roleInOrg: role === "OWNER" ? "OWNER" : "MEMBER",
        isPrimary: true,
      });
    }
    // Farm Advisor account creation lands on the immutable audit trail.
    if (role === "FARM_ADVISOR") {
      await auditEvent({
        actorUserId: me.id, actorName: me.name, actorRole: me.role,
        action: "GRANT_ACCESS", targetType: "USER", targetLabel: newUser.name,
        businessId: null, branchCode: null, ownerId: session.orgId ?? null,
        reason: null,
        detail: `Farm Advisor account created (${newUser.email}) — farm-unit access is granted separately, with optional expiry, from the Farm Advisors console`,
      });
    }
    if ((isOwner || isDelegatedMgr) && Array.isArray(extraAccessIds) && extraAccessIds.length) {
      // For delegated callers the pre-check above already proved every id is
      // inside their own branch scope.
      await replaceUserAccess(
        newUser.id,
        extraAccessIds.map(Number).filter((n) => Number.isFinite(n)),
        me.id
      );
    }

    if (isOwner && canManageAuditors) {
      await auditEvent({
        actorUserId: me.id, actorName: me.name, actorRole: me.role,
        action: "DELEGATE", targetType: "USER", targetLabel: newUser.name,
        businessId: newUser.assignedBusinessId ?? null, branchCode: null,
        reason: null, detail: `${newUser.name} (${newUser.role}) may manage Auditor access for their assigned branches`,
        ownerId: session.orgId ?? null,
      });
    }

    // New user with duty → their bell starts with the current open orders
    // and recent purchases of every business they now cover.
    const newUserBiz = await businessIdsForUser(newUser.id, newUser.assignedBusinessId ?? null);
    if (newUserBiz.length) {
      await backfillUserNotifications({ userId: newUser.id, userName: newUser.name, businessIds: newUserBiz });
    }

    return NextResponse.json({
      success: true,
      user: stripSecret(newUser),
      initialPassword,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json();
    const {
      userId,
      name,
      email,
      phone,
      role,
      assignedBusinessId,
      region,
      district,
      town,
      isActive,
      isWorkerEnabled,
      canRecordSales,
      canRecordExpenses,
      canManageStock,
      canExportData,
      canManageRecords,
      canDeleteInventory,
      canManageExpenses,
      canManageUsers,
      canManageCctv,
      canManageAuditors,
      canManageOnline,
      canCreateBusiness,
      canViewFinance,
      canManageSupport,
      newPassword,
      extraAccessIds,
      businessManageIds,
    } = body;

    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const [targetUser] = await db.select().from(users).where(eq(users.id, Number(userId)));
    if (!targetUser) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    // ── Role validation & rank ──────────────────────────────────────────
    // (1) The target's current role must be a real role — an account holding a
    //     legacy/unknown value can still be repaired but can never act.
    // (2) A requested new role must exist AND be assignable by this actor.
    // (3) Nobody may administer a PEER OR SUPERIOR (rank), which is what the
    //     dead ROLE_LEVEL map was written for (audit finding F6).
    const targetRole = normaliseRole(targetUser.role);
    const requestedRole = role !== undefined ? normaliseRole(role) : undefined;
    if (role !== undefined && !requestedRole) {
      return NextResponse.json(
        { success: false, error: `Unknown role "${String(role).slice(0, 40)}". Pick a role from the list.` },
        { status: 400 },
      );
    }
    if (requestedRole && !canAssignRole(me, requestedRole)) {
      return FORBIDDEN(`You are not authorised to assign the ${roleLabel(requestedRole)} role.`);
    }
    if (targetRole && !canActOnRole(me.role, targetRole)) {
      return FORBIDDEN(`Your role cannot administer a ${roleLabel(targetRole)} account.`);
    }

    // ── Tenant boundary ─────────────────────────────────────────────────
    // A Super Admin account may only be touched by another Super Admin —
    // and nobody may ever touch a user OUTSIDE their own organization(s).
    if (!me.isSuperAdmin) {
      if (targetUser.isSuperAdmin) {
        return FORBIDDEN("The platform Super Admin account is outside your reach.");
      }
      if (!(await sharesOrganization(me, targetUser))) {
        return FORBIDDEN("That user belongs to a different organization.");
      }
    }

    const isOwner = me.role === "OWNER";
    const isGM = me.role === "GENERAL_MANAGER" || me.role === "CO_OWNER";

    // ROLE CHANGE ⇒ ROLE PRESET. When the caller moves an account onto a new
    // role, the new role's preset replaces the old capabilities for any flag the
    // caller did not send explicitly — so "change the role" means the same thing
    // on every screen (audit finding F3). Explicit values always win.
    const roleChanged = !!requestedRole && requestedRole !== normaliseRole(targetUser.role);
    const nextPreset = rolePreset(requestedRole ?? targetUser.role);
    const nextIsAdvisor = (requestedRole ?? normaliseRole(targetUser.role)) === "FARM_ADVISOR";
    /** Capability after this PATCH: explicit value ⇒ it; role change ⇒ preset; else stored. */
    const capMeta = (k: CapabilityKey) => CAPABILITIES.find((c) => c.key === k);
    const capAfter = (sent: any, key: CapabilityKey, stored: any): boolean => {
      if (sent !== undefined) return Boolean(sent);
      // Role change ⇒ the new role's preset — but an OWNER-only capability can
      // only ride a preset when the OWNER is the one making the change.
      if (roleChanged) return nextPreset[key] === true && (isOwner || capMeta(key)?.ownerOnly !== true);
      return Boolean(stored);
    };
    const isBM = me.role === "BRANCH_MANAGER";
    // Registry-owned: who may HOLD the OWNER-delegated user-admin flag.
    const isDelegatedMgr = !isOwner && isDelegateUserManager(me);

    // ── Unit requirement on a role change ────────────────────────────────
    // Moving an account onto a unit-scoped role (Worker / Supervisor /
    // Accountant / Branch Manager) without a primary unit is a guaranteed
    // broken account, so it is refused here as well as in the pickers.
    const nextRoleKey = requestedRole ?? normaliseRole(targetUser.role);
    const nextBusinessId =
      assignedBusinessId !== undefined ? assignedBusinessId : targetUser.assignedBusinessId;
    if (roleDef(nextRoleKey)?.requiresUnit && !nextBusinessId) {
      return NextResponse.json(
        { success: false, error: `${nextRoleKey} must be assigned to a business branch` },
        { status: 400 },
      );
    }
    if (roleDef(nextRoleKey)?.forbidsUnit && nextBusinessId) {
      return NextResponse.json(
        { success: false, error: "Farm Advisors are not assigned to a branch." },
        { status: 400 },
      );
    }

    // ── Farm Advisor account rules ───────────────────────────────────────
    // Only the OWNER touches an advisor account; only the OWNER may turn
    // anyone INTO an advisor. Advisors never keep management power, grants
    // or a primary branch — access flows exclusively via advisor_assignments.
    if (targetUser.role === "FARM_ADVISOR" && !isOwner) {
      return FORBIDDEN("Only the OWNER can modify Farm Advisor accounts.");
    }
    if (role === "FARM_ADVISOR" && targetUser.role !== "FARM_ADVISOR" && !isOwner) {
      return FORBIDDEN("Only the OWNER can convert an account into a Farm Advisor.");
    }

    // Org OWNER (not Super Admin): business ids being granted must belong to
    // their OWN organization — otherwise a user could be dragged across the
    // tenant boundary through their assignment or grants.
    if (isOwner && !me.isSuperAdmin) {
      const orgBiz = new Set(await accessibleBusinessIds(me));
      if (assignedBusinessId !== undefined && assignedBusinessId && !orgBiz.has(Number(assignedBusinessId))) {
        return FORBIDDEN("You can only assign businesses inside your own organization.");
      }
      if (Array.isArray(extraAccessIds) && extraAccessIds.some((id: any) => !orgBiz.has(Number(id)))) {
        return FORBIDDEN("You can only grant access to businesses inside your own organization.");
      }
      if (businessManageIds !== undefined && cleanIdList(businessManageIds).some((id) => !orgBiz.has(id))) {
        return FORBIDDEN("You can only delegate Manage Business / Unit powers inside your own organization.");
      }
    }

    if (!isOwner) {
      // Nobody but the OWNER may touch OWNER accounts.
      if (targetUser.role === "OWNER") {
        return FORBIDDEN("Only the OWNER can modify the OWNER account.");
      }
      if (isDelegatedMgr) {
        // Delegated user admin: manage ONLY workers & branch managers whose
        // primary branch is inside the caller's own accessible scope.
        if (targetUser.id === me.id) {
          return FORBIDDEN("You cannot edit your own account from the access console.");
        }
        if (roleDef(targetUser.role)?.assignableBy !== "OWNER_OR_DELEGATE") {
          return FORBIDDEN("You can only manage Workers and Branch Managers inside your scope.");
        }
        const allowed = await accessibleBusinessIds(me);
        if (targetUser.assignedBusinessId == null || !(allowed ?? []).includes(Number(targetUser.assignedBusinessId))) {
          return FORBIDDEN("That user belongs to a branch you do not manage.");
        }
        // Record-management / delegation powers: the manager must not CHANGE
        // them (echoing the row's existing value untouched is fine — the form
        // always round-trips full state).
        // "Changed" is judged against the registry's OWNER-only capability
        // list, so a new capability can never be smuggled past a delegate by
        // forgetting to add it to this comparison (audit finding F3).
        const ownerOnlyChanged = CAPABILITIES.filter((c) => c.ownerOnly).some((c) => {
          const sent = (body as any)?.[c.key];
          return sent !== undefined && Boolean(sent) !== Boolean((targetUser as any)[c.key]);
        });
        if (
          ownerOnlyChanged ||
          (businessManageIds !== undefined && JSON.stringify(cleanIdList(businessManageIds)) !== JSON.stringify(cleanIdList(targetUser.businessManageIds)))
        ) {
          return FORBIDDEN("Only the OWNER can grant record-management, delete-inventory, expense-management, user-management, CCTV, auditor-delegation, online-storefront, branch-creation, finance-report viewing, customer-support editing or Manage Business / Unit powers.");
        }
        if (newPassword !== undefined) {
          return FORBIDDEN("Only the OWNER can reset passwords.");
        }
        if (role !== undefined && !["WORKER", "BRANCH_MANAGER"].includes(role)) {
          return FORBIDDEN("You can only assign Worker or Branch Manager roles.");
        }
        if (assignedBusinessId !== undefined && assignedBusinessId && !(allowed ?? []).includes(Number(assignedBusinessId))) {
          return FORBIDDEN("You can only assign branches you manage.");
        }
        if (Array.isArray(extraAccessIds) && extraAccessIds.some((id: any) => !(allowed ?? []).includes(Number(id)))) {
          return FORBIDDEN("You can only grant access to branches you manage.");
        }
      } else if (isGM) {
        // The executive staff-management surface is closed unless the OWNER
        // explicitly authorised it (`canManageUsers`).
        if (!canSeeEnterpriseUsers(me)) {
          return FORBIDDEN(
            "Enterprise Users is restricted to the OWNER and the users the OWNER authorises. Ask the OWNER for access."
          );
        }
        if (canManageRecords !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove record-management permission.");
        }
        if (canDeleteInventory !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove the delete-inventory permission.");
        }
        if (canManageExpenses !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove the expense-management permission.");
        }
        if (canManageCctv !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove CCTV management permission.");
        }
        if (canManageAuditors !== undefined) {
          return FORBIDDEN("Only the OWNER can delegate auditor-access management.");
        }
        if (canManageOnline !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove Online Storefront & Delivery Areas management.");
        }
        if (canCreateBusiness !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove the New Branch/Unit permission.");
        }
        if (canViewFinance !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove Finance & Reports access.");
        }
        if (canManageSupport !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove Customer Support (storefront HELP) access.");
        }
        if (businessManageIds !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove Manage Business / Unit permission.");
        }
        if (role !== undefined && !["BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT", "WORKER"].includes(role)) {
          return FORBIDDEN("GENERAL_MANAGER cannot assign elevated roles.");
        }
        if (newPassword !== undefined) {
          return FORBIDDEN("Only the OWNER can reset passwords.");
        }
        if (Array.isArray(extraAccessIds)) {
          return FORBIDDEN("Only the OWNER can change business access grants.");
        }
      } else if (isBM) {
        // Branch managers may only toggle their own workers' day-to-day flags.
        const allowed = await accessibleBusinessIds(me);
        const allowedFields = [
          "userId", "canRecordSales", "canRecordExpenses", "canManageStock", "canExportData", "isWorkerEnabled",
        ];
        const touched = Object.keys(body).filter((k) => !allowedFields.includes(k));
        if (
          targetUser.role !== "WORKER" ||
          targetUser.assignedBusinessId == null ||
          !(allowed ?? []).includes(Number(targetUser.assignedBusinessId)) ||
          touched.length > 0
        ) {
          return FORBIDDEN("Insufficient privilege.");
        }
      } else {
        return FORBIDDEN("Insufficient privilege.");
      }
    }

    // OWNER safety: the OWNER account cannot be deactivated or demoted.
    if (targetUser.role === "OWNER" && isOwner) {
      if ((isActive !== undefined && !isActive) || (role !== undefined && role !== "OWNER")) {
        return NextResponse.json(
          { success: false, error: "The OWNER account must remain an active OWNER." },
          { status: 400 }
        );
      }
    }

    // ── Advisor shape enforcement ────────────────────────────────────────
    // Converting an account to FARM_ADVISOR (or editing an existing one)
    // strips every management power, grant list and primary branch — access
    // flows exclusively through advisor_assignments. Applied to the patch
    // object AFTER the role-change authorization above, so even a form
    // round-tripping an old manager's true flags cannot smuggle power onto
    // an advisor account.
    const advisorShape =
      isOwner && String(role !== undefined ? role : targetUser.role) === "FARM_ADVISOR";

    const userPatch: any = {
        name: name !== undefined ? name : targetUser.name,
        email: email !== undefined ? String(email).trim().toLowerCase() : targetUser.email,
        phone: phone !== undefined ? phone : targetUser.phone,
        role: role !== undefined ? role : targetUser.role,
        assignedBusinessId: assignedBusinessId !== undefined ? (assignedBusinessId ? Number(assignedBusinessId) : null) : targetUser.assignedBusinessId,
        region: region !== undefined ? region || null : targetUser.region,
        district: district !== undefined ? district || null : targetUser.district,
        town: town !== undefined ? town || null : targetUser.town,
        isActive: isActive !== undefined ? Boolean(isActive) : targetUser.isActive,
        isWorkerEnabled: isWorkerEnabled !== undefined ? Boolean(isWorkerEnabled) : targetUser.isWorkerEnabled,
        // Farm Advisors hold no capability at all (read-only by construction).
        canRecordSales: nextIsAdvisor ? false : capAfter(canRecordSales, "canRecordSales", targetUser.canRecordSales),
        canRecordExpenses: nextIsAdvisor ? false : capAfter(canRecordExpenses, "canRecordExpenses", targetUser.canRecordExpenses),
        canManageStock: nextIsAdvisor ? false : capAfter(canManageStock, "canManageStock", targetUser.canManageStock),
        canExportData: nextIsAdvisor ? false : capAfter(canExportData, "canExportData", targetUser.canExportData),
        // OWNER-only toggles: the OWNER sets them (explicitly, or via the new
        // role's preset); everyone else merely echoes the stored value, because
        // non-owner edits were already rejected above.
        canManageRecords:
          isOwner ? capAfter(canManageRecords, "canManageRecords", targetUser.canManageRecords) : targetUser.canManageRecords,
        canDeleteInventory:
          isOwner ? capAfter(canDeleteInventory, "canDeleteInventory", targetUser.canDeleteInventory) : targetUser.canDeleteInventory,
        canManageExpenses:
          isOwner ? capAfter(canManageExpenses, "canManageExpenses", targetUser.canManageExpenses) : targetUser.canManageExpenses,
        // Delegation flag: OWNER-only, and only meaningful on delegate-eligible
        // roles (force off elsewhere, as before).
        canManageUsers:
          isOwner
            ? inRoleGroup("DELEGATE_ELIGIBLE", requestedRole ?? targetUser.role)
              ? capAfter(canManageUsers, "canManageUsers", targetUser.canManageUsers)
              : false
            : targetUser.canManageUsers,
        canManageCctv:
          isOwner ? capAfter(canManageCctv, "canManageCctv", targetUser.canManageCctv) : targetUser.canManageCctv,
        canManageAuditors:
          isOwner ? capAfter(canManageAuditors, "canManageAuditors", targetUser.canManageAuditors) : targetUser.canManageAuditors,
        canManageOnline:
          isOwner ? capAfter(canManageOnline, "canManageOnline", targetUser.canManageOnline) : targetUser.canManageOnline,
        canCreateBusiness:
          isOwner ? capAfter(canCreateBusiness, "canCreateBusiness", targetUser.canCreateBusiness) : targetUser.canCreateBusiness,
        canViewFinance:
          isOwner ? capAfter(canViewFinance, "canViewFinance", targetUser.canViewFinance) : targetUser.canViewFinance,
        canManageSupport:
          isOwner ? capAfter(canManageSupport, "canManageSupport", targetUser.canManageSupport) : targetUser.canManageSupport,
        // Manage Business / Unit delegation: OWNER sets it; everyone else
        // echoes the stored value.
        businessManageIds:
          isOwner && businessManageIds !== undefined
            ? cleanIdList(businessManageIds)
            : targetUser.businessManageIds,
    };
    if (advisorShape) {
      Object.assign(userPatch, {
        assignedBusinessId: null,
        canRecordSales: false,
        canRecordExpenses: false,
        canManageStock: false,
        canExportData: false,
        canManageRecords: false,
        canDeleteInventory: false,
        canManageExpenses: false,
        canManageUsers: false,
        canManageCctv: false,
        canManageAuditors: false,
        canManageOnline: false,
        canCreateBusiness: false,
        canViewFinance: false,
        canManageSupport: false,
        businessManageIds: [],
      });
    }

    const [updatedUser] = await db
      .update(users)
      .set(userPatch)
      .where(eq(users.id, Number(userId)))
      .returning();

    // ── Sensitive permission changes land on the immutable audit trail ────
    // Every grant/revoke of a power that opens money, the staff directory,
    // record management, exports, the storefront, auditor delegation or unit
    // management writes ONE audit row naming the exact flips. auditEvent also
    // rings the OWNER/CO_OWNER bell (the actor is excluded), so a grant made by
    // a delegate is visible to the people accountable for it.
    const PERMISSION_LABELS: Record<string, string> = {
      canManageUsers: "Enterprise Users",
      canViewFinance: "Finance & Reports",
      canManageRecords: "record management",
      canDeleteInventory: "inventory deletion",
      canManageExpenses: "expense management",
      canExportData: "data export",
      canManageCctv: "CCTV management",
      canManageAuditors: "auditor-access delegation",
      canManageOnline: "Online Storefront",
      canCreateBusiness: "New Branch/Unit",
      canManageSupport: "Customer Support",
      canRecordSales: "record sales",
      canRecordExpenses: "record expenses",
      canManageStock: "manage stock",
    };
    const flipped: string[] = [];
    for (const [key, label] of Object.entries(PERMISSION_LABELS)) {
      if (!(key in (userPatch as any))) continue;
      if (Boolean((userPatch as any)[key]) === Boolean((targetUser as any)[key])) continue;
      flipped.push(`${label} ${(userPatch as any)[key] ? "ON" : "OFF"}`);
    }
    if ("businessManageIds" in (userPatch as any)) {
      const before = Array.isArray(targetUser.businessManageIds) ? targetUser.businessManageIds.map(Number).sort().join(",") : "";
      const after = Array.isArray((userPatch as any).businessManageIds) ? (userPatch as any).businessManageIds.map(Number).sort().join(",") : "";
      if (before !== after) flipped.push(`Manage Business/Unit ${after || "(none)"}`);
    }
    if (newPassword !== undefined) flipped.push("password reset (all sessions revoked)");
    if (flipped.length) {
      await auditEvent({
        actorUserId: me.id,
        actorName: me.name,
        actorRole: me.role,
        action: newPassword !== undefined ? "PERMISSION_CHANGE_PASSWORD" : "PERMISSION_CHANGE",
        targetType: "USER",
        targetLabel: updatedUser.name,
        businessId: updatedUser.assignedBusinessId ?? null,
        branchCode: null,
        ownerId: session.orgId ?? null,
        detail: `${flipped.join("; ")}`,
      });
    }

    // Auditor-access delegation flips land on the immutable audit trail.
    if (isOwner && canManageAuditors !== undefined && Boolean(canManageAuditors) !== !!targetUser.canManageAuditors) {
      await auditEvent({
        actorUserId: me.id, actorName: me.name, actorRole: me.role,
        action: canManageAuditors ? "DELEGATE" : "REVOKE_DELEGATION",
        targetType: "USER", targetLabel: updatedUser.name,
        businessId: updatedUser.assignedBusinessId ?? null, branchCode: null,
        ownerId: session.orgId ?? null,
        reason: null,
        detail: canManageAuditors
          ? `${updatedUser.name} (${updatedUser.role}) may manage Auditor access for their assigned branches`
          : `Auditor-access delegation removed from ${updatedUser.name}`,
      });
    }

    if (isOwner && typeof newPassword === "string" && newPassword.trim().length >= 4) {
      await setUserPassword(targetUser.id, newPassword.trim());
      // Existing sessions of that account are revoked so the new password takes hold.
      await db.delete(userSessions).where(eq(userSessions.userId, targetUser.id));
    }

    if ((isOwner || isDelegatedMgr) && Array.isArray(extraAccessIds)) {
      // Delegated callers already passed the "grants ⊆ own scope" check above.
      await replaceUserAccess(
        targetUser.id,
        extraAccessIds.map(Number).filter((n) => Number.isFinite(n)),
        me.id
      );
    }

    const accessMap = await usersAccessMap([updatedUser.id]);

    // Duty hand-over: if the assignment or extra-access grants changed, drop
    // the current open orders + recent purchases of those businesses into the
    // user's bell (deduped — never double-notifies).
    const assignmentChanged =
      (assignedBusinessId !== undefined &&
        (assignedBusinessId ? Number(assignedBusinessId) : null) !== (targetUser.assignedBusinessId ?? null)) ||
      Array.isArray(extraAccessIds);
    if (assignmentChanged) {
      const allBiz = await businessIdsForUser(updatedUser.id, updatedUser.assignedBusinessId ?? null);
      await backfillUserNotifications({ userId: updatedUser.id, userName: updatedUser.name, businessIds: allBiz });
    }

    // Role/permission/assignment/deactivation changes must reach the very
    // next authenticated request in THIS process immediately.
    bustSessionCache();

    return NextResponse.json({
      success: true,
      user: { ...stripSecret(updatedUser), extraAccessIds: accessMap[updatedUser.id] || [] },
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const { searchParams } = new URL(request.url);
    const userId = Number(searchParams.get("userId"));
    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const [targetUser] = await db.select().from(users).where(eq(users.id, userId));
    if (!targetUser) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    if (targetUser.role === "OWNER") {
      return FORBIDDEN("The OWNER account cannot be deleted.");
    }
    if (me.role !== "OWNER") {
      return FORBIDDEN("Only the OWNER can delete user accounts.");
    }
    if (targetUser.id === me.id) {
      return FORBIDDEN("You cannot delete your own account.");
    }
    // Tenant boundary: a Super Admin account and any cross-org user are untouchable.
    if (!me.isSuperAdmin) {
      if (targetUser.isSuperAdmin) {
        return FORBIDDEN("The platform Super Admin account is outside your reach.");
      }
      if (!(await sharesOrganization(me, targetUser))) {
        return FORBIDDEN("That user belongs to a different organization.");
      }
    }

    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(userBusinessAccess).where(eq(userBusinessAccess.userId, userId));
    // Advisor grants die with the advisor account (notes survive, stamped
    // with their author — the farm's guidance history is never lost).
    await db.delete(advisorAssignments).where(eq(advisorAssignments.userId, userId));
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, userId));
    // The account's bell dies with it: a deleted person's notification rows
    // could never be read again and would skew unread counts forever, and
    // their push subscriptions would keep receiving device pushes.
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    bustSessionCache(); // deleted user's memoised sessions must not survive in this process
    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return apiError(error);
  }
}
