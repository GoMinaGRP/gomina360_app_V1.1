import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets, assetAuditLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";

export async function GET(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get("assetId");
    const status = searchParams.get("status");

    let rows = await db
      .select()
      .from(assetAuditLogs)
      .orderBy(desc(assetAuditLogs.id));

    if (assetId) rows = rows.filter((r) => r.assetId === Number(assetId));
    if (status && status !== "ALL") rows = rows.filter((r) => r.status === status);

    // Scope: a user only sees audit logs for assets in businesses they can
    // access. Only the platform Super Admin sees across all organizations.
    const user = __authSession.user;
    if (!user.isSuperAdmin) {
      const inScope = new Set(await accessibleBusinessIds(user));
      const assetRows = await db.select({ id: assets.id, businessId: assets.businessId }).from(assets);
      const assetBiz = new Map(assetRows.map((a) => [a.id, a.businessId]));
      rows = rows.filter((r) => {
        const biz = assetBiz.get(r.assetId);
        return biz != null && inScope.has(biz);
      });
    }

    return NextResponse.json({ success: true, logs: rows });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { assetId, requestedAction, detailsJson } = body;

    if (!assetId || !requestedAction) {
      return NextResponse.json(
        { success: false, error: "assetId and requestedAction are required" },
        { status: 400 }
      );
    }

    const [asset] = await db.select().from(assets).where(eq(assets.id, Number(assetId)));
    if (!asset) {
      return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });
    }

    // The requester's identity is stamped from the signed-in session — the
    // body's requestedBy* fields are never trusted.
    if (!(await canAccessBusiness(__authSession.user, asset.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const [log] = await db
      .insert(assetAuditLogs)
      .values({
        assetId: asset.id,
        assetCode: asset.assetCode,
        action: `REQUEST_${requestedAction}`,
        status: "PENDING",
        requestedByUserId: __authSession.user.id,
        requestedByName: __authSession.user.name || "Unknown Requester",
        requestedByRole: __authSession.user.role || null,
        detailsJson: detailsJson || {},
        ownerId: (await ownerOrgOfBusiness(asset.businessId)) ?? __authSession.orgId ?? null,
      })
      .returning();

    return NextResponse.json({ success: true, log });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { auditId, decision } = body;

    if (!auditId || !["APPROVED", "REJECTED"].includes(decision)) {
      return NextResponse.json(
        { success: false, error: "auditId and decision APPROVED/REJECTED are required" },
        { status: 400 }
      );
    }

    // Only executives (Owner / General Manager) may approve or reject, and
    // only inside businesses they can access.
    const role = __authSession.user.role;
    if (role !== "OWNER" && role !== "GENERAL_MANAGER") {
      return FORBIDDEN("Only the Owner or a General Manager can approve or reject asset requests.");
    }

    const [existing] = await db.select().from(assetAuditLogs).where(eq(assetAuditLogs.id, Number(auditId)));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Audit log not found" }, { status: 404 });
    }
    const [asset] = await db.select().from(assets).where(eq(assets.id, existing.assetId));
    if (asset && !(await canAccessBusiness(__authSession.user, asset.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const [log] = await db
      .update(assetAuditLogs)
      .set({
        status: decision,
        approvedByUserId: __authSession.user.id,
        approvedByName: __authSession.user.name || "Executive Approver",
        resolvedAt: new Date(),
      })
      .where(eq(assetAuditLogs.id, Number(auditId)))
      .returning();

    return NextResponse.json({ success: true, log });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
