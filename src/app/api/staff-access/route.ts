import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { users, userSessions, businesses, userBusinessAccess, organizationMembers, organizations } from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import { getSessionInfo, accessibleBusinessIds, endAllSessionsForUser, sharesOrganization, resolveUserOrgIds, UNAUTHENTICATED } from "@/lib/auth";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";

/**
 * Signed-In Staff console — who is signed in right now, from where, since
 * when; everyone else's last login & logout; and one-tap access control.
 *
 * VISIBILITY: the OWNER always; managers ONLY when the OWNER authorized
 * user-management for their account (canManageUsers + BRANCH_MANAGER /
 * GENERAL_MANAGER role) — and then strictly scoped to the branches they can
 * access. Everyone else gets meta.canView = false and zero rows.
 *
 * ACTIONS:
 *   SET_ACCESS   { userId, status: "ACTIVE" | "DISABLED" | "REVOKED" }
 *     ACTIVE   — re-enable sign-in (clears a temporary disable or a revoke).
 *     DISABLED — temporary block: sessions end at once, sign-in refused
 *                ("account deactivated"); reversible any time.
 *     REVOKED  — full removal of access: sessions end, the stored password
 *                is cleared and re-admission needs BOTH owner re-enable AND
 *                a fresh owner password reset. access_revoked_at is stamped.
 *   END_SESSION  { userId } — force-sign-out every live session (access kept).
 *
 * Guards: nobody can act on themselves; nobody but the OWNER can ever touch
 * an OWNER account; delegated managers may only manage WORKER and
 * BRANCH_MANAGER accounts whose primary branch sits inside the manager's own
 * accessible scope — mirroring the Users & Access permission model, which is
 * itself owner-grant-only.
 */

const ONLINE_WINDOW_MS = 4 * 60 * 1000;

type Actionable = "ACTIVE" | "DISABLED" | "REVOKED";

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const isOwner = me.role === "OWNER";
    const isDelegatedMgr =
      !!me.canManageUsers && ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(me.role);
    const canView = isOwner || isDelegatedMgr;
    if (!canView) {
      return NextResponse.json({
        success: true,
        meta: { canView: false, canManage: false },
        staff: [],
      });
    }

    const allowed = await accessibleBusinessIds(me);

    const [userRows, bizRows, sessRows, grantRows] = await Promise.all([
      db.select().from(users),
      db.select().from(businesses),
      db.select().from(userSessions).orderBy(desc(userSessions.id)),
      db.select().from(userBusinessAccess),
    ]);

    const bizName = (id: number | null) => {
      if (!id) return { name: "Shared HQ (all branches)", code: "HQ", branch: "—" };
      const b = bizRows.find((x) => x.id === id);
      return b ? { name: b.name, code: b.code, branch: b.branchLocation || b.code } : { name: `Business #${id}`, code: "—", branch: "—" };
    };

    const now = Date.now();
    const grantsByUser: Record<number, number[]> = {};
    for (const g of grantRows) {
      (grantsByUser[g.userId] ||= []).push(g.businessId);
    }
    const sessByUser: Record<number, any[]> = {};
    for (const s of sessRows) {
      (sessByUser[s.userId] ||= []).push(s);
    }

    // Org boundary: non-Super-Admin viewers only ever see people who share
    // their own organization — never another Owner's staff. Legacy users whose
    // accounts predate multi-owner carry no org record; for them the legacy
    // universe IS the whole tenant (no org filter), exactly as before.
    const myOrgs: number[] = Array.isArray(me.organizationIds) ? me.organizationIds.map(Number) : [];
    let memberIds: Set<number> | null = null;   // org viewers: the allowed set
    if (!me.isSuperAdmin && myOrgs.length) {
      const memberRows = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, myOrgs));
      memberIds = new Set(memberRows.map((m) => Number(m.userId)));
    }
    const visibleUser = (u: any) => {
      if (me.isSuperAdmin) return true;
      if (u.id === me.id) return true;
      if (memberIds) return memberIds.has(Number(u.id));
      return true; // legacy (org-less) viewer — unrestricted, as pre-multi-owner
    };

    // ── Org → Business grouping (Signed-In Staff, Phase A) ────────────────
    // Per-user org resolution (one query): member rows for every user we may
    // show; grouping assigns each row to the user's PRIMARY org (first by id)
    // while the flat list remains authoritative visibility.
    const allMembers = me.isSuperAdmin
      ? await db.select().from(organizationMembers)
      : (memberIds
          ? await db.select().from(organizationMembers).where(inArray(organizationMembers.organizationId, myOrgs.map(Number)))
          : []);
    const orgIdsPerUser = new Map<number, number[]>();
    for (const m of allMembers) {
      const uid = Number(m.userId);
      (orgIdsPerUser.get(uid) || orgIdsPerUser.set(uid, []).get(uid)!).push(Number(m.organizationId));
    }
    for (const v of orgIdsPerUser.values()) v.sort((a, b) => a - b);
    const orgRows = me.isSuperAdmin
      ? await db.select().from(organizations)
      : await db.select().from(organizations).where(inArray(organizations.id, myOrgs.length ? myOrgs.map(Number) : [-1]));
    const orgNameOf = (id: number | null) => {
      if (id === null) return null;
      const o = orgRows.find((x) => Number(x.id) === id);
      return o ? { id, name: o.name, status: String(o.status || "ACTIVE").toUpperCase() } : { id, name: `Organization #${id}`, status: "ACTIVE" };
    };
    const bizById = new Map(bizRows.map((b: any) => [Number(b.id), b]));
    // Optional Super-Admin drill-down: ?organizationId=N narrows the board.
    const drillOrg = (() => {
      const p = Number(new URL(request.url).searchParams.get("organizationId") || 0) || null;
      return me.isSuperAdmin ? p : null;
    })();

    const staff = userRows
      .filter((u) => {
        if (!visibleUser(u)) return false;
        if (drillOrg !== null) {
          const ids = orgIdsPerUser.get(Number(u.id)) || [];
          if (!ids.includes(drillOrg)) return false;
        }
        if (isOwner || me.isSuperAdmin) return true;
        // delegated manager: only staff whose primary branch is in-scope
        return u.assignedBusinessId != null && (allowed ?? []).includes(Number(u.assignedBusinessId));
      })
      .map((u) => {
        const sessions = sessByUser[u.id] || [];
        const live = sessions.filter(
          (s) => !s.endedAt && (!s.expiresAt || new Date(s.expiresAt).getTime() > now),
        );
        const latest = (arr: any[], pick: (s: any) => any) =>
          arr.reduce((m: any, s: any) => {
            const v = pick(s);
            return v && (!m || new Date(v) > new Date(m)) ? v : m;
          }, null);
        const currentSignInAt = latest(live, (s) => s.createdAt);
        const lastSeenAt = latest(live, (s) => s.lastSeenAt);
        const parked = live.length > 0 && live.every((s) => !!s.revokedAt);
        const signedInNow = live.length > 0;
        const onlineNow =
          signedInNow &&
          !parked &&
          !!lastSeenAt &&
          now - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
        const accessStatus = u.isActive === false ? (u.accessRevokedAt ? "REVOKED" : "DISABLED") : "ACTIVE";
        const biz = bizName(u.assignedBusinessId ?? null);
        // Provenance (Phase C): from the newest LIVE session that carried it.
        const prov = [...live]
          .sort((a, b) => Number(b.id) - Number(a.id))
          .find((s) => s.deviceLabel || s.initialBusinessId != null) || null;
        const idb = prov?.initialBusinessId != null ? bizById.get(Number(prov.initialBusinessId)) : null;
        // Multi-org membership shows on SA rows as "+N orgs" context.
        const memberOrgIds = orgIdsPerUser.get(Number(u.id)) || [];
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          phone: u.phone,
          role: u.role,
          photoUrl: u.avatarUrl || null,
          businessId: u.assignedBusinessId ?? null,
          businessName: biz.name,
          businessCode: biz.code,
          branch: biz.branch,
          grantedBusinessIds: grantsByUser[u.id] || [],
          // Phase A: explicit organization identity — Super Admin ONLY (F-6).
          ...(me.isSuperAdmin
            ? {
                organizationId: memberOrgIds[0] ?? u.primaryOrgId ?? null,
                organizationName: orgNameOf(memberOrgIds[0] ?? u.primaryOrgId ?? null)?.name || null,
                organizationStatus: orgNameOf(memberOrgIds[0] ?? u.primaryOrgId ?? null)?.status || null,
                extraOrgCount: Math.max(0, memberOrgIds.length - 1),
              }
            : {}),
          // Phase C: sign-in provenance of the newest lived session.
          deviceLabel: prov?.deviceLabel || null,
          ipHash: prov?.ipHash || null,
          initialBusiness: idb ? { id: idb.id, name: idb.name, code: idb.code } : null,
          grantedBranches: (grantsByUser[u.id] || [])
            .map((id) => bizById.get(Number(id)))
            .filter(Boolean)
            .map((b: any) => ({ id: b.id, name: b.name, code: b.code })),
          permissions: {
            canRecordSales: !!u.canRecordSales,
            canRecordExpenses: !!u.canRecordExpenses,
            canManageStock: !!u.canManageStock,
            canExportData: !!u.canExportData,
            canManageRecords: !!u.canManageRecords,
            canManageUsers: !!u.canManageUsers,
          },
          accessStatus,
          isActive: u.isActive !== false,
          accessRevokedAt: u.accessRevokedAt || null,
          hasPassword: !!u.passwordHash,
          signedInNow,
          onlineNow,
          sessionCount: live.length,
          currentSignInAt,
          lastSeenAt,
          lastLoginAt: latest(sessions, (s) => s.createdAt),
          lastLogoutAt: latest(sessions, (s) => s.endedAt),
          memberSince: u.createdAt,
        };
      })
      // presence first, then most recent activity, then name — the live board
      .sort((a, b) => {
        const rank = (x: any) => (x.onlineNow ? 0 : x.signedInNow ? 1 : 2);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        const at = a.lastSeenAt || a.lastLoginAt || "";
        const bt = b.lastSeenAt || b.lastLoginAt || "";
        if (at !== bt) return String(bt).localeCompare(String(at));
        return a.name.localeCompare(b.name);
      });

    // Group assemblies (display-only grouping; the flat list above is the
    // authorization contract):
    //  · SUPER_ADMIN      — one group per org (incl. legacy org group "—"),
    //    business buckets inside, ordered by live headcount.
    //  · OWNER_ORG        — their org as the single group header; business
    //    buckets = their org's units (staff-holding only) + an HQ bucket.
    //  · MANAGER_BRANCHES — branches inside their granted scope, no org data.
    const metaScopeType = me.isSuperAdmin ? "SUPER_ADMIN" : isOwner ? "OWNER_ORG" : "MANAGER_BRANCHES";
    // Non-SA viewers get a SINGLE group: the Owner's own org (they know it,
    // no cross-org signal) — or a neutral "Your scope" for branch managers.
    const ownGroupId = me.isSuperAdmin ? null : myOrgs[0] != null && isOwner ? Number(myOrgs[0]) : 0;
    const groupOf = (s: any): number | null => {
      if (me.isSuperAdmin) return s.organizationId ?? 0; // 0 = platform users w/o org (legacy)
      return ownGroupId;
    };
    const orgGroups: any[] = [];
    const orgBucketOf = (oid: number | null) => {
      let g = orgGroups.find((x) => x.orgId === oid);
      if (!g) {
        const info = oid !== null && oid !== 0 ? orgNameOf(oid) : null;
        const ownInfo = !me.isSuperAdmin && oid !== null && oid !== 0 ? orgNameOf(oid) : null;
        g = {
          orgId: oid ?? 0,
          orgName: info?.name || ownInfo?.name
            || (me.isSuperAdmin && oid === 0 ? "Platform accounts (no organization)" : (oid ?? 0) === 0 ? (isOwner ? "Your organization" : "Your branches") : `Organization #${oid}`),
          orgStatus: info?.status || ownInfo?.status || "ACTIVE",
          businesses: new Map<number, any>(),
          staffIds: [] as number[],
        };
        orgGroups.push(g);
      }
      return g;
    };
    for (const s of staff) {
      const g = orgBucketOf(groupOf(s));
      g.staffIds.push(s.id);
      const bid = s.businessId ?? 0; // 0 = HQ bucket
      if (!g.businesses.has(bid)) {
        g.businesses.set(bid, {
          businessId: bid === 0 ? 0 : bid,
          businessName: bid === 0 ? "— Shared / HQ (no primary branch) —" : s.businessName,
          businessCode: bid === 0 ? "HQ" : s.businessCode,
          staffIds: [] as number[],
        });
      }
      g.businesses.get(bid)!.staffIds.push(s.id);
    }
    const selectStaff = (ids: number[]) => staff.filter((s) => ids.includes(s.id));
    const groups = orgGroups.map((g) => {
      const gs = selectStaff(g.staffIds);
      return {
        orgId: g.orgId,
        orgName: g.orgName,
        orgStatus: g.orgStatus,
        counts: {
          total: gs.length,
          signedIn: gs.filter((s) => s.signedInNow).length,
          online: gs.filter((s) => s.onlineNow).length,
        },
        businesses: [...g.businesses.values()]
          .map((b: any) => {
            const bs = selectStaff(b.staffIds);
            return {
              ...b,
              counts: {
                total: bs.length,
                signedIn: bs.filter((s) => s.signedInNow).length,
                online: bs.filter((s) => s.onlineNow).length,
              },
            };
          })
          .sort((a: any, b: any) => b.counts.online - a.counts.online || b.counts.signedIn - a.counts.signedIn || a.businessName.localeCompare(b.businessName)),
      };
    }).sort((a: any, b: any) => b.counts.online - a.counts.online || a.orgName.localeCompare(b.orgName));

    return NextResponse.json({
      success: true,
      meta: {
        canView: true,
        canManage: true,
        scope: isOwner || me.isSuperAdmin ? "ALL" : (allowed ?? []),
        scopeType: metaScopeType,
        organizationCount: me.isSuperAdmin ? orgGroups.length : undefined,
        drillOrg,
        onlineCount: staff.filter((s) => s.onlineNow).length,
        signedInCount: staff.filter((s) => s.signedInNow).length,
        disabledCount: staff.filter((s) => s.accessStatus === "DISABLED").length,
        revokedCount: staff.filter((s) => s.accessStatus === "REVOKED").length,
        groups,
      },
      staff,
    });
  } catch (e: any) {
    if (typeof (e as any)?.status === "number") return apiError(e);
    console.error("staff-access GET error", e);
    return NextResponse.json({ success: false, error: e?.message || "Failed to load staff access" }, { status: 500 });
  }
}

const FORBID = (msg: string) => NextResponse.json({ success: false, error: msg }, { status: 403 });

export async function POST(request: NextRequest) {
  ttlInvalidate("init");
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const userId = Number(body.userId) || 0;
    if (!userId) return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });

    // Phase D1: audit-trail context — resolved once, used by every action.
    const actorOrgId = (Array.isArray(me.organizationIds) ? me.organizationIds[0] : me.primaryOrgId) ?? null;

    const isOwner = me.role === "OWNER";
    const isDelegatedMgr =
      !!me.canManageUsers && ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(me.role);
    if (!isOwner && !isDelegatedMgr) {
      return FORBID("Only the OWNER — or a manager the OWNER authorized for user management — can manage staff access.");
    }

    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    const targetBizCode = target.assignedBusinessId != null
      ? ((await db.select({ code: businesses.code }).from(businesses).where(eq(businesses.id, target.assignedBusinessId)))[0]?.code ?? null)
      : null;
    if (target.id === me.id) return FORBID("You cannot change your own access from this console.");
    if (target.role === "OWNER") return FORBID("The OWNER account can never be disabled or revoked.");
    // Tenant boundary: never act outside your own organization, and never on
    // the platform Super Admin account. Refusal wording is scope-blind (no
    // org-existence signal to an id-probing caller); details stay server-side.
    if (!me.isSuperAdmin) {
      if (target.isSuperAdmin) return FORBID("That account is outside your scope.");
      if (!(await sharesOrganization(me, target))) {
        const targetOrgs = await resolveUserOrgIds(target).catch(() => [] as number[]);
        console.warn(`[staff-access] cross-org action refused: actor=${me.id} orgs=${JSON.stringify(me.organizationIds || [])} target=${target.id} orgs=${JSON.stringify(targetOrgs)}`);
        return FORBID("That account is outside your scope.");
      }
    }

    if (!isOwner) {
      // Delegated managers: Workers & Branch Managers inside their scope only.
      if (!["WORKER", "BRANCH_MANAGER"].includes(target.role)) {
        return FORBID("You can only manage Workers and Branch Managers inside your scope.");
      }
      const allowed = await accessibleBusinessIds(me);
      if (target.assignedBusinessId == null || !(allowed ?? []).includes(Number(target.assignedBusinessId))) {
        return FORBID("That user belongs to a branch you do not manage.");
      }
    }

    if (action === "SET_ACCESS") {
      const status = String(body.status || "").toUpperCase() as Actionable;
      if (!["ACTIVE", "DISABLED", "REVOKED"].includes(status)) {
        return NextResponse.json({ success: false, error: "status must be ACTIVE, DISABLED or REVOKED" }, { status: 400 });
      }
      if (status === "ACTIVE") {
        // Re-enable: sessions state is untouched; the user can sign in again.
        // (After a REVOKE the password was cleared — an owner password reset
        // is still required before the account can actually sign in.)
        await db
          .update(users)
          .set({ isActive: true, accessRevokedAt: null, failedLoginAttempts: 0, lockedUntil: null })
          .where(eq(users.id, target.id));
      } else if (status === "DISABLED") {
        await db.update(users).set({ isActive: false }).where(eq(users.id, target.id));
        await endAllSessionsForUser(target.id, "DISABLED");
      } else {
        // REVOKED — the hard stop: no way back without the OWNER.
        await db
          .update(users)
          .set({ isActive: false, accessRevokedAt: new Date(), passwordHash: null })
          .where(eq(users.id, target.id));
        await endAllSessionsForUser(target.id, "REVOKED");
      }
      // Governance evidence (Phase D1): every access mutation is a trail row.
      await auditLog(
        me,
        status === "ACTIVE" ? "STAFF_ENABLE" : status === "DISABLED" ? "STAFF_DISABLE" : "STAFF_REVOKE",
        "USER",
        target.name,
        null,
        target.id,
        target.assignedBusinessId ?? null,
        targetBizCode,
        status === "ACTIVE"
          ? "Access re-enabled from Signed-In Staff console."
          : status === "DISABLED"
            ? "Access disabled from Signed-In Staff console — sessions ended DISABLED, sign-in blocked."
            : "Access revoked from Signed-In Staff console — sessions ended REVOKED, credentials cleared.",
        actorOrgId != null ? Number(actorOrgId) : null,
      );
      return NextResponse.json({
        success: true,
        status,
        message:
          status === "ACTIVE"
            ? `${target.name}'s access is ENABLED.`
            : status === "DISABLED"
              ? `${target.name}'s access is DISABLED — signed out everywhere and blocked from signing in.`
              : `${target.name}'s access is REVOKED — signed out everywhere, credentials cleared. Re-admission requires re-enable + a new password.`,
      });
    }

    if (action === "END_SESSION") {
      await endAllSessionsForUser(target.id, "FORCE_LOGOUT");
      await auditLog(
        me, "STAFF_FORCE_LOGOUT", "USER", target.name, null, target.id,
        target.assignedBusinessId ?? null,
        targetBizCode,
        "Force sign-out of every device from Signed-In Staff console (access unchanged).",
        actorOrgId != null ? Number(actorOrgId) : null,
      );
      return NextResponse.json({ success: true, message: `${target.name} was signed out of all devices.` });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    if (typeof (e as any)?.status === "number") return apiError(e);
    console.error("staff-access POST error", e);
    return NextResponse.json({ success: false, error: e?.message || "Failed to update staff access" }, { status: 500 });
  }
}
