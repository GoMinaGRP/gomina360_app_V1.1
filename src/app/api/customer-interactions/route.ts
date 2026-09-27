import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customerInteractions, customers } from "@/db/schema";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  UNAUTHENTICATED,
  FORBIDDEN,
} from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { customer360, customerInsights, upcomingFollowUps } from "@/lib/customerInsights";

/**
 * /api/customer-interactions — R3 CRM timeline.
 *
 * GET  ?customerId=            → the customer's interactions (newest first)
 *      ?businessId=            → the unit's timeline
 *      ?followUps=1            → upcoming follow-ups (today and later)
 *      ?insights=1             → RFM segments for the caller's scope
 *      ?customerId=&include360=1 → the full 360 payload (profile, orders,
 *                                  credit, statement, interactions)
 * POST    { customerId, type, summary, detail?, followUpOn?, occurredAt? } —
 *         any staff member with access to the customer's unit may log.
 * PATCH   { id, summary?, detail?, followUpOn? } — the author, or a manager
 *         of the unit.
 * DELETE  ?id= — the author, the org OWNER, or a unit manager.
 */
const TYPES = ["CALL", "VISIT", "MESSAGE", "COMPLAINT", "FOLLOW_UP", "NOTE"];

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const url = new URL(request.url);
    const customerId = Number(url.searchParams.get("customerId") || 0) || null;
    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;

    const allowed = await accessibleBusinessIds(me);
    const inScope = (bizId: any) => allowed === null || bizId == null || allowed.map(Number).includes(Number(bizId));

    if (url.searchParams.get("insights") === "1") {
      const insights = await customerInsights({ businessIds: allowed });
      return NextResponse.json({ success: true, insights, scope: allowed === null ? "ALL" : allowed });
    }

    if (url.searchParams.get("followUps") === "1") {
      const rows = await upcomingFollowUps(allowed);
      return NextResponse.json({ success: true, followUps: rows });
    }

    if (customerId && url.searchParams.get("include360") === "1") {
      const [cust] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!cust) return NextResponse.json({ success: false, error: "Customer not found." }, { status: 404 });
      // Business-stamped customers require unit scope; shared (businessId
      // NULL) rows stay visible org-wide, matching the CRM doctrine.
      if (!inScope(cust.businessId) && !me.isSuperAdmin) {
        return FORBIDDEN("That customer is outside your scope.");
      }
      const data = await customer360(customerId);
      return NextResponse.json({ success: true, customer360: data });
    }

    let rows = await db.select().from(customerInteractions);
    if (customerId) rows = rows.filter((r) => Number(r.customerId) === customerId);
    if (bizFilter) rows = rows.filter((r) => Number(r.businessId) === bizFilter);
    rows = rows.filter((r) => inScope(r.businessId));
    rows.sort((a, b) => (String(b.occurredAt || b.createdAt || "") > String(a.occurredAt || a.createdAt || "") ? 1 : -1));
    return NextResponse.json({ success: true, interactions: rows });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();

    const customerId = Number(body?.customerId || 0);
    if (!customerId) return NextResponse.json({ success: false, error: "customerId is required." }, { status: 400 });
    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId));
    if (!cust) return NextResponse.json({ success: false, error: "Customer not found." }, { status: 404 });
    // Shared (businessId NULL) customers resolve to OWNER/GM-only, matching
    // the enterprise PATCH doctrine.
    if (!(await canAccessBusiness(me, cust.businessId ?? -1))) {
      return FORBIDDEN("You cannot log interactions for that customer.");
    }

    const type = String(body?.type || "NOTE").toUpperCase();
    if (!TYPES.includes(type)) {
      return NextResponse.json({ success: false, error: `type must be one of ${TYPES.join(", ")}.` }, { status: 400 });
    }
    const summary = String(body?.summary || "").trim().slice(0, 300);
    if (!summary) return NextResponse.json({ success: false, error: "A summary is required." }, { status: 400 });
    const followUpOn = String(body?.followUpOn || "").slice(0, 10) || null;
    if (followUpOn && !/^\d{4}-\d{2}-\d{2}$/.test(followUpOn)) {
      return NextResponse.json({ success: false, error: "followUpOn must be yyyy-mm-dd." }, { status: 400 });
    }

    const orgId = cust.ownerId != null ? Number(cust.ownerId) : cust.businessId != null ? await ownerOrgOfBusiness(Number(cust.businessId)) : null;
    const [row] = await db
      .insert(customerInteractions)
      .values({
        ownerId: Number(orgId) || 1,
        businessId: cust.businessId != null ? Number(cust.businessId) : null,
        customerId,
        type,
        summary,
        detail: body?.detail != null ? String(body.detail).trim().slice(0, 2000) || null : null,
        followUpOn,
        actorUserId: me.id ?? null,
        actorName: me.name || "Staff",
        actorRole: me.role || null,
        occurredAt: String(body?.occurredAt || "").slice(0, 10) || new Date().toLocaleDateString("en-CA"),
      })
      .returning();
    await auditLog(me, "CREATE", "RECORD", `Interaction: ${summary.slice(0, 60)}`, "CUSTOMER_INTERACTION", row.id, cust.businessId != null ? Number(cust.businessId) : null, null, `${type} on ${cust.name}`, orgId);
    return NextResponse.json({ success: true, interaction: row });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const id = Number(body?.id || 0);
    const [row] = await db.select().from(customerInteractions).where(eq(customerInteractions.id, id));
    if (!row) return NextResponse.json({ success: false, error: "Interaction not found." }, { status: 404 });
    const isAuthor = Number(row.actorUserId) === Number(me.id);
    const isManager = row.businessId != null && (await canAccessBusiness(me, Number(row.businessId))) && ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(String(me.role || ""));
    if (!isAuthor && !isManager && !me.isSuperAdmin) {
      return FORBIDDEN("Only the author or a manager of the unit can edit this interaction.");
    }
    const updates: any = {};
    if (body?.summary != null) {
      const s = String(body.summary).trim().slice(0, 300);
      if (!s) return NextResponse.json({ success: false, error: "Summary cannot be empty." }, { status: 400 });
      updates.summary = s;
    }
    if (body?.detail !== undefined) updates.detail = String(body.detail || "").trim().slice(0, 2000) || null;
    if (body?.followUpOn !== undefined) {
      const f = String(body.followUpOn || "").slice(0, 10) || null;
      if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return NextResponse.json({ success: false, error: "followUpOn must be yyyy-mm-dd." }, { status: 400 });
      updates.followUpOn = f;
    }
    const [updated] = await db.update(customerInteractions).set(updates).where(eq(customerInteractions.id, id)).returning();
    return NextResponse.json({ success: true, interaction: updated });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id") || 0);
    const [row] = await db.select().from(customerInteractions).where(eq(customerInteractions.id, id));
    if (!row) return NextResponse.json({ success: false, error: "Interaction not found." }, { status: 404 });
    const isAuthor = Number(row.actorUserId) === Number(me.id);
    const isOrgOwner = ["OWNER"].includes(String(me.role || "")) && (row.ownerId != null ? (me.organizationIds || []).map(Number).includes(Number(row.ownerId)) : true);
    const isManager = row.businessId != null && (await canAccessBusiness(me, Number(row.businessId))) && ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(String(me.role || ""));
    if (!isAuthor && !isOrgOwner && !isManager && !me.isSuperAdmin) {
      return FORBIDDEN("Only the author, the Owner or a unit manager can delete this interaction.");
    }
    await db.delete(customerInteractions).where(eq(customerInteractions.id, id));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return apiError(error);
  }
}
