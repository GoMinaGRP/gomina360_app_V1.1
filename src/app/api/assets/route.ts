import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets, assetAuditLogs, businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

async function hasApprovedPermission(
  assetId: number,
  action: "EDIT" | "TRANSFER" | "DELETE",
  auditId?: number
) {
  if (!auditId) return false;
  const [log] = await db
    .select()
    .from(assetAuditLogs)
    .where(eq(assetAuditLogs.id, auditId));
  return !!(
    log &&
    log.assetId === assetId &&
    log.status === "APPROVED" &&
    log.action === `REQUEST_${action}`
  );
}

export async function PATCH(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { assetId, actorUserId, actorName, actorRole, approvedAuditId, updates } = body;

    if (!assetId) {
      return NextResponse.json({ success: false, error: "assetId is required" }, { status: 400 });
    }

    const [asset] = await db.select().from(assets).where(eq(assets.id, Number(assetId)));
    if (!asset) return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });

    const isExecutive = actorRole === "OWNER" || actorRole === "GENERAL_MANAGER";
    const isBranchManagerAllowed =
      actorRole === "BRANCH_MANAGER" &&
      (await hasApprovedPermission(Number(assetId), updates?.businessId || updates?.branchCode ? "TRANSFER" : "EDIT", approvedAuditId ? Number(approvedAuditId) : undefined));

    if (!isExecutive && !isBranchManagerAllowed) {
      return NextResponse.json(
        { success: false, error: "Approval is required before a Branch Manager can edit or transfer this asset." },
        { status: 403 }
      );
    }

    let businessPatch: any = {};
    if (updates?.businessId) {
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(updates.businessId)));
      if (!biz) return NextResponse.json({ success: false, error: "Target business not found" }, { status: 400 });
      businessPatch = {
        businessId: Number(updates.businessId),
        branchCode: updates.branchCode || biz.code,
        branchName: updates.branchName || biz.name,
        region: updates.region || biz.region,
        district: updates.district || biz.district,
        town: updates.town || biz.town,
      };
    }

    const [updated] = await db
      .update(assets)
      .set({
        name: updates?.name ?? asset.name,
        assetType: updates?.assetType ?? asset.assetType,
        purchasePriceGhs: updates?.purchasePriceGhs !== undefined ? Number(updates.purchasePriceGhs) : asset.purchasePriceGhs,
        currentValueGhs: updates?.currentValueGhs !== undefined ? Number(updates.currentValueGhs) : asset.currentValueGhs,
        condition: updates?.condition ?? asset.condition,
        location: updates?.location ?? asset.location,
        nextMaintenanceDate: updates?.nextMaintenanceDate ?? asset.nextMaintenanceDate,
        assetImages: Array.isArray(updates?.assetImages) ? updates.assetImages : asset.assetImages,
        ...businessPatch,
      })
      .where(eq(assets.id, Number(assetId)))
      .returning();

    await db.insert(assetAuditLogs).values({
      assetId: updated.id,
      assetCode: updated.assetCode,
      action: businessPatch.businessId ? "TRANSFER" : "EDIT",
      status: "COMPLETED",
      requestedByUserId: actorUserId ? Number(actorUserId) : null,
      requestedByName: actorName || "Unknown Actor",
      requestedByRole: actorRole || null,
      detailsJson: { before: asset, after: updated, approvedAuditId: approvedAuditId || null },
    });

    return NextResponse.json({ success: true, asset: updated });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const assetId = Number(searchParams.get("assetId"));
    const actorUserId = searchParams.get("actorUserId");
    const actorName = searchParams.get("actorName") || "Unknown Actor";
    const actorRole = searchParams.get("actorRole");
    const approvedAuditId = searchParams.get("approvedAuditId");

    if (!assetId) return NextResponse.json({ success: false, error: "assetId is required" }, { status: 400 });

    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!asset) return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });

    const isExecutive = actorRole === "OWNER" || actorRole === "GENERAL_MANAGER";
    const bmAllowed =
      actorRole === "BRANCH_MANAGER" &&
      (await hasApprovedPermission(assetId, "DELETE", approvedAuditId ? Number(approvedAuditId) : undefined));

    if (!isExecutive && !bmAllowed) {
      return NextResponse.json(
        { success: false, error: "Approval is required before a Branch Manager can delete this asset." },
        { status: 403 }
      );
    }

    await db.delete(assets).where(eq(assets.id, assetId));
    await db.insert(assetAuditLogs).values({
      assetId: asset.id,
      assetCode: asset.assetCode,
      action: "DELETE",
      status: "COMPLETED",
      requestedByUserId: actorUserId ? Number(actorUserId) : null,
      requestedByName: actorName,
      requestedByRole: actorRole || null,
      detailsJson: { deletedAsset: asset, approvedAuditId: approvedAuditId || null },
    });

    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
