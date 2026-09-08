import { NextResponse } from "next/server";
import { db } from "@/db";
import { users, userSessions, userBusinessAccess, auditTrail } from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  usersAccessMap,
  setUserPassword,
  replaceUserAccess,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { backfillUserNotifications, businessIdsForUser } from "@/lib/notify";
import crypto from "crypto";

const stripSecret = (u: any) => {
  const {
    passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe
  } = u;
  return { ...safe, hasPassword: Boolean(u.passwordHash) };
};

const ROLE_LEVEL: Record<string, number> = {
  OWNER: 4,
  GENERAL_MANAGER: 3,
  BRANCH_MANAGER: 2,
  SUPERVISOR: 2,
  ACCOUNTANT: 2,
  WORKER: 1,
};

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const isExec = ["OWNER", "GENERAL_MANAGER"].includes(me.role);
    const allowed = await accessibleBusinessIds(me);

    let rows = await db.select().from(users).orderBy(desc(users.id));
    if (!isExec) {
      rows = rows.filter(
        (u) =>
          u.id === me.id ||
          (u.assignedBusinessId != null && (allowed ?? []).includes(Number(u.assignedBusinessId)))
      );
    }

    const accessMap = await usersAccessMap(rows.map((u) => u.id));
    return NextResponse.json({
      success: true,
      users: rows.map((u) => ({ ...stripSecret(u), extraAccessIds: accessMap[u.id] || [] })),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json();
    const {
      name,
      email,
      role,
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
      canManageUsers,
      canManageCctv,
      canManageAuditors,
      canManageOnline,
      canCreateBusiness,
      canViewFinance,
      canManageSupport,
      password,
      extraAccessIds,
    } = body;

    if (!name || !email || !role) {
      return NextResponse.json(
        { success: false, error: "Name, email, and role are required" },
        { status: 400 }
      );
    }

    const isOwner = me.role === "OWNER";
    const isBranchManager = me.role === "BRANCH_MANAGER";
    // OWNER-delegated user administrator: manager (branch or general) trusted
    // to run Users & Access strictly within the branches they can access.
    const isDelegatedMgr =
      !isOwner && !!me.canManageUsers && ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(me.role);
    if (!isOwner) {
      const allowed = await accessibleBusinessIds(me);
      if (isDelegatedMgr) {
        // Delegated managers create WORKERS and BRANCH MANAGERS only, always
        // pinned to a branch inside their own scope; extra grants are capped
        // at that same scope. They can never mint elevated roles, hand out
        // record-management, or extend the delegation itself.
        if (!["WORKER", "BRANCH_MANAGER"].includes(role)) {
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
        // business they themselves can access.
        if (!isBranchManager || role !== "WORKER") {
          return FORBIDDEN("Only the OWNER can create user accounts.");
        }
        if (!assignedBusinessId || !(allowed ?? []).includes(Number(assignedBusinessId))) {
          return FORBIDDEN("You can only create workers for your own business.");
        }
      }
    }

    // WORKER must have an assigned business
    if (role === "WORKER" && !assignedBusinessId) {
      return NextResponse.json(
        { success: false, error: "WORKER must be assigned to a business branch" },
        { status: 400 }
      );
    }

    // canManageRecords is OWNER-granted only (a non-owner merely ECHOING the
    // inherited false default is not a grant — only a truthy value is).
    if (!!canManageRecords && !isOwner) {
      return FORBIDDEN("Only the OWNER can grant record-management permission.");
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
    // Non-OWNER can never create other elevated roles.
    if (!isOwner && (!!canManageRecords || !!canManageCctv || !!canManageAuditors || !!canManageOnline || !!canCreateBusiness || !!canViewFinance || !!canManageSupport || ["OWNER", "GENERAL_MANAGER"].includes(role))) {
      return FORBIDDEN("Insufficient privilege.");
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
          avatarUrl ||
          "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop",
        region: region || null,
        district: district || null,
        town: town || null,
        isActive: true,
        isWorkerEnabled: role === "WORKER" ? true : undefined,
        createdByUserId: me.id,
        canRecordSales: role === "WORKER" ? (canRecordSales ?? true) : undefined,
        canRecordExpenses: role === "WORKER" ? (canRecordExpenses ?? false) : undefined,
        canManageStock: role === "WORKER" ? (canManageStock ?? false) : undefined,
        canExportData: ["OWNER", "GENERAL_MANAGER"].includes(role)
          ? true
          : Boolean(canExportData ?? false),
        canManageRecords: isOwner ? Boolean(canManageRecords ?? false) : false,
        // CCTV management is likewise OWNER-granted only.
        canManageCctv: isOwner ? Boolean(canManageCctv ?? false) : false,
        // Auditor-access delegation is equally OWNER-granted only.
        canManageAuditors: isOwner ? Boolean(canManageAuditors ?? false) : false,
        // Online Storefront & Delivery Areas management — OWNER-granted only.
        canManageOnline: isOwner ? Boolean(canManageOnline ?? false) : false,
        // "New Branch/Unit" creation — OWNER-granted only.
        canCreateBusiness: isOwner ? Boolean(canCreateBusiness ?? false) : false,
        // Enterprise Finance & Reports viewing — OWNER-granted only.
        canViewFinance: isOwner ? Boolean(canViewFinance ?? false) : false,
        // Customer Support (storefront HELP) editing — OWNER-granted only.
        canManageSupport: isOwner ? Boolean(canManageSupport ?? false) : false,
        // Delegation flag is OWNER-granted and only meaningful on managers.
        canManageUsers:
          isOwner && ["GENERAL_MANAGER", "BRANCH_MANAGER"].includes(role)
            ? Boolean(canManageUsers ?? false)
            : false,
      })
      .returning();

    await setUserPassword(newUser.id, initialPassword);
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
      await db.insert(auditTrail).values({
        actorUserId: me.id, actorName: me.name, actorRole: me.role,
        action: "DELEGATE", targetType: "USER", targetLabel: newUser.name,
        businessId: newUser.assignedBusinessId ?? null, branchCode: null,
        reason: null, detail: `${newUser.name} (${newUser.role}) may manage Auditor access for their assigned branches`,
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
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
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
      canManageUsers,
      canManageCctv,
      canManageAuditors,
      canManageOnline,
      canCreateBusiness,
      canViewFinance,
      canManageSupport,
      newPassword,
      extraAccessIds,
    } = body;

    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const [targetUser] = await db.select().from(users).where(eq(users.id, Number(userId)));
    if (!targetUser) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const isOwner = me.role === "OWNER";
    const isGM = me.role === "GENERAL_MANAGER";
    const isBM = me.role === "BRANCH_MANAGER";
    const isDelegatedMgr =
      !isOwner && !!me.canManageUsers && ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(me.role);

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
        if (!["WORKER", "BRANCH_MANAGER"].includes(targetUser.role)) {
          return FORBIDDEN("You can only manage Workers and Branch Managers inside your scope.");
        }
        const allowed = await accessibleBusinessIds(me);
        if (targetUser.assignedBusinessId == null || !(allowed ?? []).includes(Number(targetUser.assignedBusinessId))) {
          return FORBIDDEN("That user belongs to a branch you do not manage.");
        }
        // Record-management / delegation powers: the manager must not CHANGE
        // them (echoing the row's existing value untouched is fine — the form
        // always round-trips full state).
        if (
          (canManageRecords !== undefined && Boolean(canManageRecords) !== !!targetUser.canManageRecords) ||
          (canManageUsers !== undefined && Boolean(canManageUsers) !== !!targetUser.canManageUsers) ||
          (canManageCctv !== undefined && Boolean(canManageCctv) !== !!targetUser.canManageCctv) ||
          (canManageAuditors !== undefined && Boolean(canManageAuditors) !== !!targetUser.canManageAuditors) ||
          (canManageOnline !== undefined && Boolean(canManageOnline) !== !!targetUser.canManageOnline) ||
          (canCreateBusiness !== undefined && Boolean(canCreateBusiness) !== !!targetUser.canCreateBusiness) ||
          (canViewFinance !== undefined && Boolean(canViewFinance) !== !!targetUser.canViewFinance) ||
          (canManageSupport !== undefined && Boolean(canManageSupport) !== !!targetUser.canManageSupport)
        ) {
          return FORBIDDEN("Only the OWNER can grant record-management, user-management, CCTV, auditor-delegation, online-storefront, branch-creation, finance-report viewing or customer-support editing powers.");
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
        if (canManageRecords !== undefined) {
          return FORBIDDEN("Only the OWNER can grant or remove record-management permission.");
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

    const [updatedUser] = await db
      .update(users)
      .set({
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
        canRecordSales: canRecordSales !== undefined ? Boolean(canRecordSales) : targetUser.canRecordSales,
        canRecordExpenses: canRecordExpenses !== undefined ? Boolean(canRecordExpenses) : targetUser.canRecordExpenses,
        canManageStock: canManageStock !== undefined ? Boolean(canManageStock) : targetUser.canManageStock,
        canExportData: canExportData !== undefined ? Boolean(canExportData) : targetUser.canExportData,
        canManageRecords: canManageRecords !== undefined ? Boolean(canManageRecords) : targetUser.canManageRecords,
        // OWNER-only toggle, meaningful on manager roles only (else force off).
        canManageUsers:
          isOwner && canManageUsers !== undefined
            ? ["GENERAL_MANAGER", "BRANCH_MANAGER"].includes(role ?? targetUser.role)
              ? Boolean(canManageUsers)
              : false
            : targetUser.canManageUsers,
        // CCTV management: only the OWNER may change it (non-owner edits were
        // already rejected above unless the value was echoed unchanged).
        canManageCctv:
          isOwner && canManageCctv !== undefined
            ? Boolean(canManageCctv)
            : targetUser.canManageCctv,
        // Auditor-access delegation likewise: OWNER may flip it, everyone
        // else merely echoes the stored value.
        canManageAuditors:
          isOwner && canManageAuditors !== undefined
            ? Boolean(canManageAuditors)
            : targetUser.canManageAuditors,
        // Online Storefront & Delivery Areas management likewise.
        canManageOnline:
          isOwner && canManageOnline !== undefined
            ? Boolean(canManageOnline)
            : targetUser.canManageOnline,
        // "New Branch/Unit" creation likewise: OWNER grants/revokes it.
        canCreateBusiness:
          isOwner && canCreateBusiness !== undefined
            ? Boolean(canCreateBusiness)
            : targetUser.canCreateBusiness,
        canViewFinance:
          isOwner && canViewFinance !== undefined
            ? Boolean(canViewFinance)
            : targetUser.canViewFinance,
        // Customer Support (storefront HELP) editing likewise: OWNER flips
        // it, everyone else merely echoes the stored value.
        canManageSupport:
          isOwner && canManageSupport !== undefined
            ? Boolean(canManageSupport)
            : targetUser.canManageSupport,
      })
      .where(eq(users.id, Number(userId)))
      .returning();

    // Auditor-access delegation flips land on the immutable audit trail.
    if (isOwner && canManageAuditors !== undefined && Boolean(canManageAuditors) !== !!targetUser.canManageAuditors) {
      await db.insert(auditTrail).values({
        actorUserId: me.id, actorName: me.name, actorRole: me.role,
        action: canManageAuditors ? "DELEGATE" : "REVOKE_DELEGATION",
        targetType: "USER", targetLabel: updatedUser.name,
        businessId: updatedUser.assignedBusinessId ?? null, branchCode: null,
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

    return NextResponse.json({
      success: true,
      user: { ...stripSecret(updatedUser), extraAccessIds: accessMap[updatedUser.id] || [] },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSessionInfo(request);
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

    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(userBusinessAccess).where(eq(userBusinessAccess.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
