/**
 * Farm Advisor — visits (engagement log).
 *
 *   GET   ?businessId=            → visits for the farm (scoped)
 *   POST  { businessId, visitType, plannedDate|actualDate, summary, status }
 *   PATCH { id, ...updates }      → complete a visit, attach the summary
 *
 * A completed visit generates the Advisory Digest for its window and stores
 * the snapshot on the visit row, then notifies the Owner and managers.
 */
import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { advisorVisits } from "@/db/schema";
import { accessibleBusinessIds, canAccessBusiness, getSessionInfo, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import { advisorGrantFor, isAdvisor } from "@/lib/advisorAccess";
import { advisoryRecipients, generateDigest, notifyUsers, todayISO } from "@/lib/advisorServer";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";
import { ownerOrgOfBusiness } from "@/lib/notify";

const TYPES = ["ON_SITE", "REMOTE"];
const STATUSES = ["PLANNED", "COMPLETED", "MISSED"];
const isDate = (v: any) => !v || /^\d{4}-\d{2}-\d{2}$/.test(String(v));

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId")) || null;
    let ids: number[];
    if (businessId) {
      if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that farm.");
      ids = [businessId];
    } else {
      ids = (await accessibleBusinessIds(me)) ?? [];
    }
    if (!ids.length) return NextResponse.json({ success: true, visits: [] });
    const visits = await db.select().from(advisorVisits).where(inArray(advisorVisits.businessId, ids)).orderBy(desc(advisorVisits.id));
    return NextResponse.json({ success: true, visits });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const businessId = Number(body.businessId);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that farm.");
    if (isAdvisor(me) && !(await advisorGrantFor(me, businessId))) {
      return FORBIDDEN("Your advisory access to this farm is not active.");
    }
    if (!isDate(body.plannedDate) || !isDate(body.actualDate)) {
      return NextResponse.json({ success: false, error: "Dates must be YYYY-MM-DD." }, { status: 400 });
    }
    const status = STATUSES.includes(String(body.status)) ? String(body.status) : body.actualDate ? "COMPLETED" : "PLANNED";
    const [row] = await db
      .insert(advisorVisits)
      .values({
        businessId,
        branchCode: body.branchCode ? String(body.branchCode) : null,
        advisorUserId: me.id,
        advisorName: me.name,
        visitType: TYPES.includes(String(body.visitType)) ? String(body.visitType) : "ON_SITE",
        plannedDate: body.plannedDate || null,
        actualDate: body.actualDate || (status === "COMPLETED" ? todayISO() : null),
        durationMins: Number(body.durationMins) > 0 ? Number(body.durationMins) : null,
        summary: body.summary ? String(body.summary).slice(0, 4000) : null,
        status,
        ownerId: await ownerOrgOfBusiness(businessId),
      })
      .returning();

    let saved = row;
    if (status === "COMPLETED") {
      const grant = isAdvisor(me) ? await advisorGrantFor(me, businessId) : null;
      const digest = await generateDigest(businessId, { windowDays: 30, grant });
      const [withDigest] = await db.update(advisorVisits).set({ aiDigest: digest as any }).where(eq(advisorVisits.id, row.id)).returning();
      saved = withDigest || row;
      await notifyUsers(await advisoryRecipients(businessId, digest.severity === "URGENT" ? "HIGH" : "MEDIUM", [me.id]), {
        type: "ADVISOR_VISIT_SUMMARY",
        title: `Advisor visit completed — ${digest.headline}`.slice(0, 200),
        body: digest.summary,
        businessId,
        recordType: "ADVISOR_VISIT",
        recordId: row.id,
        actorName: me.name,
        url: "/?tab=ADVISORY",
      });
    }
    await auditLog(me, "ADVISOR_VISIT_LOG", "RECORD", `${row.visitType} visit`, "ADVISOR_VISIT", row.id, businessId, row.branchCode, `Status ${status}`, session.orgId ?? null);
    return NextResponse.json({ success: true, visit: saved });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    const [existing] = await db.select().from(advisorVisits).where(eq(advisorVisits.id, id));
    if (!existing) return NextResponse.json({ success: false, error: "Visit not found." }, { status: 404 });
    if (!(await canAccessBusiness(me, existing.businessId))) return FORBIDDEN("You do not have access to that farm.");
    if (isAdvisor(me) && Number(existing.advisorUserId) !== Number(me.id)) {
      return FORBIDDEN("You can only update your own visits.");
    }
    const status = STATUSES.includes(String(body.status)) ? String(body.status) : existing.status;
    const [row] = await db
      .update(advisorVisits)
      .set({
        status,
        actualDate: body.actualDate !== undefined ? body.actualDate || null : status === "COMPLETED" ? existing.actualDate || todayISO() : existing.actualDate,
        durationMins: body.durationMins !== undefined ? (Number(body.durationMins) > 0 ? Number(body.durationMins) : null) : existing.durationMins,
        summary: body.summary !== undefined ? String(body.summary).slice(0, 4000) : existing.summary,
        updatedAt: new Date(),
      })
      .where(eq(advisorVisits.id, id))
      .returning();

    let savedRow = row;
    if (status === "COMPLETED" && existing.status !== "COMPLETED") {
      const grant = isAdvisor(me) ? await advisorGrantFor(me, existing.businessId) : null;
      const digest = await generateDigest(existing.businessId, { windowDays: 30, grant });
      const [withDigest] = await db.update(advisorVisits).set({ aiDigest: digest as any }).where(eq(advisorVisits.id, id)).returning();
      savedRow = withDigest || row;
      await notifyUsers(await advisoryRecipients(existing.businessId, "MEDIUM", [me.id]), {
        type: "ADVISOR_VISIT_SUMMARY",
        title: `Advisor visit completed — ${digest.headline}`.slice(0, 200),
        body: digest.summary,
        businessId: existing.businessId,
        recordType: "ADVISOR_VISIT",
        recordId: id,
        actorName: me.name,
        url: "/?tab=ADVISORY",
      });
    }
    await auditLog(me, "ADVISOR_VISIT_UPDATE", "RECORD", `${row.visitType} visit`, "ADVISOR_VISIT", id, existing.businessId, existing.branchCode, `Status ${status}`, session.orgId ?? null);
    return NextResponse.json({ success: true, visit: savedRow });
  } catch (error: any) {
    return apiError(error);
  }
}
