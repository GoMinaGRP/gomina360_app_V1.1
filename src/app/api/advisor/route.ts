// Farm Advisor access grants — OWNER-controlled, scoped, expirable.
//
//   GET              → FARM_ADVISOR: own assignments (with unit names, scope,
//                      expiry state, section visibility). OWNER / GM-with-
//                      canManageUsers: every assignment of their organization
//                      + the advisor directory + grantable farm units.
//   POST             → grant { userId, businessIds[], scopeNote?, validUntil?,
//                      sectionsByBusiness? { businessId: [sectionKey,…] } }
//                      (one assignment per unit; re-granting a revoked unit
//                      re-activates it; omitted map = ALL sections). OWNER /
//                      delegated GM only.
//   PATCH            → update / revoke { assignmentId, isActive?, validUntil?,
//                      scopeNote?, sections? } (sections: null = all).
//
// The advisor role resolves access EXCLUSIVELY from these rows (see
// accessibleBusinessIds in lib/auth) — granting or revoking here is the whole
// story of an advisor's reach, and every mutation lands on audit_trail.

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  advisorAssignments,
  auditTrail,
  businesses,
  organizationMembers,
  users,
} from "@/db/schema";
import {
  accessibleBusinessIds,
  canAccessBusiness,
  getSessionInfo,
  isFarmAdvisor,
  sharesOrganization,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { farmModuleOfBusiness, normalizeSections, sectionCatalog } from "@/lib/advisorSections";
import { apiError } from "@/lib/apiError";

const today = () => new Date().toISOString().slice(0, 10);
const isGrantManager = (me: any) =>
  me.role === "OWNER" ||
  (!!me.canManageUsers && ["GENERAL_MANAGER", "BRANCH_MANAGER"].includes(String(me.role)));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    if (isFarmAdvisor(me)) {
      const rows = await db
        .select()
        .from(advisorAssignments)
        .where(eq(advisorAssignments.userId, Number(me.id)));
      const bizIds = [...new Set(rows.map((r) => Number(r.businessId)))];
      const bizRows = bizIds.length
        ? await db.select().from(businesses).where(inArray(businesses.id, bizIds))
        : [];
      const day = today();
      return NextResponse.json({
        success: true,
        assignments: rows.map((r) => {
          const biz = bizRows.find((b) => Number(b.id) === Number(r.businessId));
          const expired = !!r.validUntil && String(r.validUntil) < day;
          return {
            ...r,
            businessName: biz?.name || `Unit #${r.businessId}`,
            businessCode: biz?.code || null,
            businessCategory: biz?.category || null,
            expired,
            effective: r.isActive !== false && !expired,
          };
        }),
      });
    }

    if (!isGrantManager(me)) {
      return FORBIDDEN("Only the OWNER (or a delegated user manager) manages Farm Advisor access.");
    }

    const allowed = await accessibleBusinessIds(me);
    const scope = allowed === null ? null : allowed;
    const rows = await db.select().from(advisorAssignments);
    const scoped = scope === null ? rows : rows.filter((r) => scope.includes(Number(r.businessId)));

    // Advisor directory: FARM_ADVISOR accounts sharing the caller's org.
    const advisorRows = await db.select().from(users).where(eq(users.role, "FARM_ADVISOR"));
    const mine: any[] = [];
    for (const a of advisorRows) {
      if (me.isSuperAdmin || (await sharesOrganization(me, a))) mine.push(a);
    }
    const grantableBiz = (scope === null
      ? await db.select().from(businesses)
      : await db.select().from(businesses).where(inArray(businesses.id, scope.length ? scope : [-1]))
    ).map((b) => ({ id: b.id, name: b.name, code: b.code, category: b.category, status: b.status }));

    return NextResponse.json({
      success: true,
      assignments: scoped,
      advisors: mine.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        phone: a.phone,
        isActive: a.isActive,
      })),
      businesses: grantableBiz,
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
    if (!isGrantManager(me)) {
      return FORBIDDEN("Only the OWNER (or a delegated user manager) grants Farm Advisor access.");
    }

    const body = await request.json();
    const userId = Number(body?.userId);
    const businessIds: number[] = Array.isArray(body?.businessIds)
      ? [...new Set<number>(body.businessIds.map((b: any) => Number(b)).filter((n: number) => Number.isFinite(n) && n > 0))]
      : [];
    const scopeNote = String(body?.scopeNote || "").trim().slice(0, 300) || null;
    const validUntil = body?.validUntil ? String(body.validUntil).slice(0, 10) : null;
    // Per-section visibility: { businessId: [sectionKey, …] } — validated
    // against each unit's module catalog. Absent/undefined = ALL sections
    // (legacy default); an empty array = intentionally nothing.
    const rawSectionMap: Record<string, any> =
      body?.sectionsByBusiness && typeof body.sectionsByBusiness === "object" ? body.sectionsByBusiness : {};
    const sectionsFor = (bid: number): string[] | null | "INVALID" => {
      const raw = rawSectionMap[String(bid)];
      if (raw === undefined) return null;
      if (!Array.isArray(raw)) return "INVALID";
      return raw.map((k: any) => String(k));
    };

    if (!userId || !businessIds.length) {
      return NextResponse.json({ success: false, error: "userId and at least one businessId are required." }, { status: 400 });
    }
    if (validUntil && (!DATE_RE.test(validUntil) || validUntil < today())) {
      return NextResponse.json(
        { success: false, error: "validUntil must be a YYYY-MM-DD date of today or later (or empty for no expiry)." },
        { status: 400 },
      );
    }

    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target || !isFarmAdvisor(target)) {
      return NextResponse.json({ success: false, error: "Farm Advisor access can only be granted to a FARM_ADVISOR account." }, { status: 400 });
    }
    if (!me.isSuperAdmin && !(await sharesOrganization(me, target))) {
      return FORBIDDEN("That advisor belongs to a different organization.");
    }
    if (target.isActive === false) {
      return NextResponse.json({ success: false, error: "That advisor account is deactivated — reactivate it first." }, { status: 400 });
    }
    // Every granted unit must be inside the granter's own reach.
    for (const bid of businessIds) {
      if (!(await canAccessBusiness(me, bid))) {
        return FORBIDDEN("You can only grant access to businesses inside your own organization.");
      }
    }

    const existing = await db.select().from(advisorAssignments).where(eq(advisorAssignments.userId, userId));
    const bizRows = await db
      .select({ id: businesses.id, name: businesses.name, code: businesses.code, category: businesses.category })
      .from(businesses)
      .where(inArray(businesses.id, businessIds.length ? businessIds : [-1]));
    const bizById = new Map(bizRows.map((b) => [Number(b.id), b]));

    // Validate the requested section keys against each unit's catalog BEFORE
    // writing anything — one bad key rejects the whole grant (no partial state).
    const normalizedSections = new Map<number, string[] | null>();
    for (const bid of businessIds) {
      const raw = sectionsFor(bid);
      if (raw === "INVALID") {
        return NextResponse.json(
          { success: false, error: "sectionsByBusiness must map businessId → array of section keys (or be omitted for all sections)." },
          { status: 400 },
        );
      }
      const moduleKey = farmModuleOfBusiness(bizById.get(bid) || null);
      const norm = normalizeSections(raw, moduleKey);
      if (raw !== null && norm !== null && raw.length !== norm.length) {
        const catalog = sectionCatalog(moduleKey).map((s) => s.key);
        return NextResponse.json(
          {
            success: false,
            error: `Unknown section key(s) for unit ${bizById.get(bid)?.code || bid}. Valid keys: ${catalog.join(", ")}`,
          },
          { status: 400 },
        );
      }
      normalizedSections.set(bid, norm);
    }

    let granted = 0;
    let reactivated = 0;
    for (const bid of businessIds) {
      const sections = normalizedSections.get(bid) ?? null;
      const prior = existing.find((e) => Number(e.businessId) === bid);
      if (prior) {
        await db
          .update(advisorAssignments)
          .set({
            isActive: true,
            scopeNote,
            validUntil,
            sections,
            grantedByUserId: Number(me.id),
            grantedByName: String(me.name || "Owner"),
            grantedByRole: String(me.role || "OWNER"),
            updatedAt: new Date(),
          })
          .where(eq(advisorAssignments.id, prior.id));
        if (prior.isActive === false) reactivated++;
        else granted++;
      } else {
        await db.insert(advisorAssignments).values({
          userId,
          userName: String(target.name || "Advisor"),
          userRole: "FARM_ADVISOR",
          businessId: bid,
          branchCode: null,
          scopeNote,
          validUntil,
          sections,
          isActive: true,
          grantedByUserId: Number(me.id),
          grantedByName: String(me.name || "Owner"),
          grantedByRole: String(me.role || "OWNER"),
        });
        granted++;
      }
      const biz = bizById.get(bid);
      await db.insert(auditTrail).values({
        actorUserId: Number(me.id),
        actorName: String(me.name || "Owner"),
        actorRole: String(me.role || "OWNER"),
        action: "GRANT_ACCESS",
        targetType: "USER",
        targetLabel: `${target.name} → ${biz?.name || `unit #${bid}`}`,
        businessId: bid,
        branchCode: biz?.code || null,
        reason: scopeNote,
        detail: `Farm Advisor access granted to ${target.name} for ${biz?.name || `unit #${bid}`}${validUntil ? ` until ${validUntil}` : " (no expiry)"}${scopeNote ? ` — scope: ${scopeNote}` : ""}${sections ? ` — sections: ${sections.length ? sections.join(", ") : "none"}` : " — all sections"}`,
        ownerId: session.orgId ?? null,
      });
    }

    return NextResponse.json({ success: true, granted, reactivated });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    if (!isGrantManager(me)) {
      return FORBIDDEN("Only the OWNER (or a delegated user manager) manages Farm Advisor access.");
    }

    const body = await request.json();
    const assignmentId = Number(body?.assignmentId);
    if (!assignmentId) {
      return NextResponse.json({ success: false, error: "assignmentId is required." }, { status: 400 });
    }
    const [assignment] = await db.select().from(advisorAssignments).where(eq(advisorAssignments.id, assignmentId));
    if (!assignment) {
      return NextResponse.json({ success: false, error: "Assignment not found." }, { status: 404 });
    }
    if (!(await canAccessBusiness(me, Number(assignment.businessId)))) {
      return FORBIDDEN("That assignment belongs to a business outside your reach.");
    }

    const patch: any = { updatedAt: new Date() };
    if (body?.scopeNote !== undefined) patch.scopeNote = String(body.scopeNote).trim().slice(0, 300) || null;
    if (body?.validUntil !== undefined) {
      const vu = body.validUntil ? String(body.validUntil).slice(0, 10) : null;
      if (vu && (!DATE_RE.test(vu) || vu < today())) {
        return NextResponse.json(
          { success: false, error: "validUntil must be a YYYY-MM-DD date of today or later (or empty for no expiry)." },
          { status: 400 },
        );
      }
      patch.validUntil = vu;
    }
    if (body?.isActive !== undefined) patch.isActive = Boolean(body.isActive);
    if (body?.sections !== undefined) {
      // Section visibility is per-unit: validate against this unit's module
      // catalog. null / "ALL" sentinel = every section (legacy default);
      // an empty array = intentionally nothing.
      const raw = body.sections === null ? null : Array.isArray(body.sections) ? body.sections : ["\u0000"];
      const [bizRow] = await db
        .select({ category: businesses.category, code: businesses.code })
        .from(businesses)
        .where(eq(businesses.id, Number(assignment.businessId)));
      const moduleKey = farmModuleOfBusiness(bizRow || null);
      const norm = normalizeSections(raw, moduleKey);
      if (raw !== null && norm === null) {
        return NextResponse.json(
          { success: false, error: "sections must be an array of section keys, or null for all sections." },
          { status: 400 },
        );
      }
      if (raw !== null && raw.length !== norm!.length) {
        return NextResponse.json(
          {
            success: false,
            error: `Unknown section key(s) for unit ${bizRow?.code || assignment.businessId}. Valid keys: ${sectionCatalog(moduleKey).map((s) => s.key).join(", ")}`,
          },
          { status: 400 },
        );
      }
      patch.sections = norm;
    }

    await db.update(advisorAssignments).set(patch).where(eq(advisorAssignments.id, assignmentId));

    const revoked = body?.isActive === false;
    const [biz] = await db
      .select({ name: businesses.name, code: businesses.code })
      .from(businesses)
      .where(eq(businesses.id, Number(assignment.businessId)));
    await db.insert(auditTrail).values({
      actorUserId: Number(me.id),
      actorName: String(me.name || "Owner"),
      actorRole: String(me.role || "OWNER"),
      action: revoked ? "REVOKE_ACCESS" : "UPDATE_GRANT",
      targetType: "USER",
      targetLabel: `${assignment.userName} → ${biz?.name || `unit #${assignment.businessId}`}`,
      businessId: Number(assignment.businessId),
      branchCode: biz?.code || null,
      reason: body?.reason ? String(body.reason).slice(0, 300) : null,
      detail: revoked
        ? `Farm Advisor access REVOKED for ${assignment.userName} on ${biz?.name || `unit #${assignment.businessId}`}`
        : `Farm Advisor grant updated for ${assignment.userName} on ${biz?.name || `unit #${assignment.businessId}`}${patch.validUntil !== undefined ? ` — expiry now ${patch.validUntil || "none"}` : ""}${patch.sections !== undefined ? ` — sections now ${patch.sections === null ? "ALL" : patch.sections.length ? patch.sections.join(", ") : "none"}` : ""}`,
      ownerId: session.orgId ?? null,
    });

    return NextResponse.json({ success: true, assignmentId });
  } catch (error: any) {
    return apiError(error);
  }
}
