import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, userSessions, businesses, userBusinessAccess } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { getSessionInfo, accessibleBusinessIds, endAllSessionsForUser, UNAUTHENTICATED } from "@/lib/auth";

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

    const staff = userRows
      .filter((u) => {
        if (isOwner) return true;
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

    return NextResponse.json({
      success: true,
      meta: {
        canView: true,
        canManage: true,
        scope: isOwner ? "ALL" : (allowed ?? []),
        onlineCount: staff.filter((s) => s.onlineNow).length,
        signedInCount: staff.filter((s) => s.signedInNow).length,
        disabledCount: staff.filter((s) => s.accessStatus === "DISABLED").length,
        revokedCount: staff.filter((s) => s.accessStatus === "REVOKED").length,
      },
      staff,
    });
  } catch (e: any) {
    console.error("staff-access GET error", e);
    return NextResponse.json({ success: false, error: e?.message || "Failed to load staff access" }, { status: 500 });
  }
}

const FORBID = (msg: string) => NextResponse.json({ success: false, error: msg }, { status: 403 });

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const userId = Number(body.userId) || 0;
    if (!userId) return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });

    const isOwner = me.role === "OWNER";
    const isDelegatedMgr =
      !!me.canManageUsers && ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(me.role);
    if (!isOwner && !isDelegatedMgr) {
      return FORBID("Only the OWNER — or a manager the OWNER authorized for user management — can manage staff access.");
    }

    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    if (target.id === me.id) return FORBID("You cannot change your own access from this console.");
    if (target.role === "OWNER") return FORBID("The OWNER account can never be disabled or revoked.");

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
      return NextResponse.json({ success: true, message: `${target.name} was signed out of all devices.` });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    console.error("staff-access POST error", e);
    return NextResponse.json({ success: false, error: e?.message || "Failed to update staff access" }, { status: 500 });
  }
}
