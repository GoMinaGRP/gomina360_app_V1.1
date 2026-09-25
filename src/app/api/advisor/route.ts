/**
 * Farm Advisor — access grants (Owner-controlled) + advisor context.
 *
 *   GET    → OWNER / canManageAdvisors delegate: every advisor account and
 *            grant inside their accessible businesses (+ live/expired state).
 *            ADVISOR: their OWN live grants and engagement window.
 *   POST   → create a grant  { userId, businessId, branchCode?, scopes[],
 *            flockIds[]?, showCosts?, canExport?, startsOn?, endsOn?, note? }
 *   PATCH  → update / pause / resume / revoke a grant { id, ... , isActive }
 *
 * An ADVISOR can never reach POST/PATCH here: the central read-only gate in
 * lib/auth.ts rejects every non-GET request from a read-only actor to any path
 * outside the advisor allowlist (this route is NOT on it).
 */

import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { advisorAssignments, users, ADVISOR_DEFAULT_SCOPES } from "@/db/schema";
import {
  accessibleBusinessIds,
  canAccessBusiness,
  getSessionInfo,
  sharesOrganization,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import {
  ADVISOR_ROLE,
  canManageAdvisors,
  grantInWindow,
  isAdvisor,
  listAdvisorGrants,
  resolveAdvisorGrants,
  sanitizeScopes,
} from "@/lib/advisorAccess";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { endAllSessionsForUser } from "@/lib/auth";
import { ttlInvalidate } from "@/lib/ttlCache";
import { notifyUsers } from "@/lib/advisorServer";

const cleanIds = (v: any): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];

const isDate = (v: any) => !v || /^\d{4}-\d{2}-\d{2}$/.test(String(v));

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    // The advisor's own view: which farms, which scopes, until when.
    if (isAdvisor(me)) {
      const grants = await resolveAdvisorGrants(me);
      const all = await db.select().from(advisorAssignments).where(eq(advisorAssignments.userId, Number(me.id)));
      return NextResponse.json({
        success: true,
        meta: { canManage: false, isAdvisor: true },
        grants: all.map((g) => ({ ...g, live: grantInWindow(g) })),
        liveGrants: grants,
        advisors: [],
      });
    }

    const allowed = await accessibleBusinessIds(me);
    const manage = canManageAdvisors(me);
    const rows = await listAdvisorGrants(allowed);
    // Advisor accounts inside the caller's organization (for the picker).
    const advisorRows = manage
      ? (await db.select().from(users).where(eq(users.role, ADVISOR_ROLE)))
      : [];
    const advisors = [] as any[];
    for (const a of advisorRows) {
      if (await sharesOrganization(me, a)) {
        const { passwordHash, failedLoginAttempts, lockedUntil, ...safe } = a as any;
        advisors.push(safe);
      }
    }
    return NextResponse.json({
      success: true,
      meta: { canManage: manage, isAdvisor: false },
      grants: rows.sort((a: any, b: any) => (b.id || 0) - (a.id || 0)),
      advisors,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    if (!canManageAdvisors(me)) {
      return FORBIDDEN("Only the OWNER (or a manager the OWNER authorised) can grant Farm Advisor access.");
    }
    const body = await request.json();
    const userId = Number(body.userId);
    const businessId = Number(body.businessId);
    if (!userId || !businessId) {
      return NextResponse.json({ success: false, error: "userId and businessId are required" }, { status: 400 });
    }
    if (!isDate(body.startsOn) || !isDate(body.endsOn)) {
      return NextResponse.json({ success: false, error: "Dates must be YYYY-MM-DD." }, { status: 400 });
    }
    if (body.startsOn && body.endsOn && String(body.startsOn) > String(body.endsOn)) {
      return NextResponse.json({ success: false, error: "The engagement end date cannot precede its start date." }, { status: 400 });
    }
    if (!(await canAccessBusiness(me, businessId))) {
      return FORBIDDEN("You can only grant advisor access to businesses you manage.");
    }
    const [advisor] = await db.select().from(users).where(eq(users.id, userId));
    if (!advisor) return NextResponse.json({ success: false, error: "Advisor account not found." }, { status: 404 });
    if (String(advisor.role).toUpperCase() !== ADVISOR_ROLE) {
      return FORBIDDEN("Only an account with the Farm Advisor role can receive advisor access.");
    }
    if (!(await sharesOrganization(me, advisor))) {
      return FORBIDDEN("That user belongs to a different organization.");
    }

    const scopes = sanitizeScopes(body.scopes?.length ? body.scopes : ADVISOR_DEFAULT_SCOPES);
    const [row] = await db
      .insert(advisorAssignments)
      .values({
        userId,
        userName: advisor.name,
        businessId,
        branchCode: body.branchCode ? String(body.branchCode) : null,
        scopes,
        flockIds: cleanIds(body.flockIds),
        showCosts: body.showCosts === true,
        canExport: body.canExport === true,
        startsOn: body.startsOn || null,
        endsOn: body.endsOn || null,
        isActive: true,
        note: body.note ? String(body.note).slice(0, 600) : null,
        grantedByUserId: me.id,
        grantedByName: me.name,
        grantedByRole: me.role,
        ownerId: await ownerOrgOfBusiness(businessId),
      })
      .returning();

    await auditLog(
      me, "ADVISOR_ACCESS_GRANT", "USER", advisor.name, "ADVISOR_ASSIGNMENT", row.id, businessId,
      row.branchCode, `Scopes: ${scopes.join(", ")} · costs ${row.showCosts ? "visible" : "hidden"} · window ${row.startsOn || "now"} → ${row.endsOn || "open"}`,
      session.orgId ?? null,
    );
    await notifyUsers([userId], {
      type: "ADVISOR_ACCESS_GRANTED",
      title: "Farm advisory access granted",
      body: `You can now review farm operations${row.endsOn ? ` until ${row.endsOn}` : ""}.`,
      businessId,
      branchCode: row.branchCode,
      actorName: me.name,
      url: "/?tab=ADVISORY",
    });
    ttlInvalidate("init");
    return NextResponse.json({ success: true, grant: { ...row, live: grantInWindow(row) } });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    if (!canManageAdvisors(me)) {
      return FORBIDDEN("Only the OWNER (or a manager the OWNER authorised) can change Farm Advisor access.");
    }
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    const [existing] = await db.select().from(advisorAssignments).where(eq(advisorAssignments.id, id));
    if (!existing) return NextResponse.json({ success: false, error: "Grant not found." }, { status: 404 });
    if (!(await canAccessBusiness(me, existing.businessId))) {
      return FORBIDDEN("That grant belongs to a business outside your scope.");
    }
    if (!isDate(body.startsOn) || !isDate(body.endsOn)) {
      return NextResponse.json({ success: false, error: "Dates must be YYYY-MM-DD." }, { status: 400 });
    }

    const [row] = await db
      .update(advisorAssignments)
      .set({
        scopes: body.scopes !== undefined ? sanitizeScopes(body.scopes) : existing.scopes,
        flockIds: body.flockIds !== undefined ? cleanIds(body.flockIds) : existing.flockIds,
        branchCode: body.branchCode !== undefined ? (body.branchCode ? String(body.branchCode) : null) : existing.branchCode,
        showCosts: body.showCosts !== undefined ? body.showCosts === true : existing.showCosts,
        canExport: body.canExport !== undefined ? body.canExport === true : existing.canExport,
        startsOn: body.startsOn !== undefined ? body.startsOn || null : existing.startsOn,
        endsOn: body.endsOn !== undefined ? body.endsOn || null : existing.endsOn,
        isActive: body.isActive !== undefined ? body.isActive === true : existing.isActive,
        note: body.note !== undefined ? (body.note ? String(body.note).slice(0, 600) : null) : existing.note,
        updatedAt: new Date(),
      })
      .where(eq(advisorAssignments.id, id))
      .returning();

    // Revoking (or pausing) access ends the advisor's live sessions at once —
    // the same hard cut-off the Signed-In Staff console uses.
    const revoked = body.isActive === false && existing.isActive !== false;
    if (revoked) {
      const stillLive = (await db.select().from(advisorAssignments).where(eq(advisorAssignments.userId, existing.userId)))
        .filter((g) => grantInWindow(g));
      if (!stillLive.length) await endAllSessionsForUser(existing.userId, "REVOKED");
    }

    await auditLog(
      me,
      revoked ? "ADVISOR_ACCESS_REVOKE" : "ADVISOR_ACCESS_UPDATE",
      "USER", existing.userName, "ADVISOR_ASSIGNMENT", id, existing.businessId, row.branchCode,
      revoked
        ? "Advisor access revoked — live sessions ended"
        : `Scopes: ${(row.scopes as string[]).join(", ")} · costs ${row.showCosts ? "visible" : "hidden"} · window ${row.startsOn || "now"} → ${row.endsOn || "open"}`,
      session.orgId ?? null,
    );
    ttlInvalidate("init");
    return NextResponse.json({ success: true, grant: { ...row, live: grantInWindow(row) } });
  } catch (error: any) {
    return apiError(error);
  }
}
