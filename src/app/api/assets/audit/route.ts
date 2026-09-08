import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets, assetAuditLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

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
    const {
      assetId,
      requestedAction,
      requestedByUserId,
      requestedByName,
      requestedByRole,
      detailsJson,
    } = body;

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

    const [log] = await db
      .insert(assetAuditLogs)
      .values({
        assetId: asset.id,
        assetCode: asset.assetCode,
        action: `REQUEST_${requestedAction}`,
        status: "PENDING",
        requestedByUserId: requestedByUserId ? Number(requestedByUserId) : null,
        requestedByName: requestedByName || "Unknown Requester",
        requestedByRole: requestedByRole || null,
        detailsJson: detailsJson || {},
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
    const { auditId, decision, approvedByUserId, approvedByName } = body;

    if (!auditId || !["APPROVED", "REJECTED"].includes(decision)) {
      return NextResponse.json(
        { success: false, error: "auditId and decision APPROVED/REJECTED are required" },
        { status: 400 }
      );
    }

    const [log] = await db
      .update(assetAuditLogs)
      .set({
        status: decision,
        approvedByUserId: approvedByUserId ? Number(approvedByUserId) : null,
        approvedByName: approvedByName || "Executive Approver",
        resolvedAt: new Date(),
      })
      .where(eq(assetAuditLogs.id, Number(auditId)))
      .returning();

    return NextResponse.json({ success: true, log });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
