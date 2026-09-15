import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets, assetAuditLogs, businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";

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
    const { assetId, approvedAuditId, updates } = body;

    if (!assetId) {
      return NextResponse.json({ success: false, error: "assetId is required" }, { status: 400 });
    }

    const [asset] = await db.select().from(assets).where(eq(assets.id, Number(assetId)));
    if (!asset) return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });

    // Identity & role come from the signed-in session — the request body's
    // actorRole/actorUserId are NEVER trusted for authorization.
    const actorRole = __authSession.user.role;
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

    // Even executives act only inside businesses they can access; a transfer
    // additionally requires access to the TARGET business.
    if (!(await canAccessBusiness(__authSession.user, asset.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    if (updates?.businessId && !(await canAccessBusiness(__authSession.user, Number(updates.businessId)))) {
      return FORBIDDEN("You do not have access to the target business.");
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
      requestedByUserId: __authSession.user.id,
      requestedByName: __authSession.user.name || "Unknown Actor",
      requestedByRole: actorRole || null,
      detailsJson: { before: asset, after: updated, approvedAuditId: approvedAuditId || null },
      ownerId: (await ownerOrgOfBusiness(asset.businessId)) ?? __authSession.orgId ?? null,
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
    const approvedAuditId = searchParams.get("approvedAuditId");

    if (!assetId) return NextResponse.json({ success: false, error: "assetId is required" }, { status: 400 });

    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!asset) return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });

    // Identity & role come from the signed-in session — query-string
    // actorUserId/actorName/actorRole are NEVER trusted for authorization.
    const actorRole = __authSession.user.role;
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

    if (!(await canAccessBusiness(__authSession.user, asset.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    await db.delete(assets).where(eq(assets.id, assetId));
    await db.insert(assetAuditLogs).values({
      assetId: asset.id,
      assetCode: asset.assetCode,
      action: "DELETE",
      status: "COMPLETED",
      requestedByUserId: __authSession.user.id,
      requestedByName: __authSession.user.name || "Unknown Actor",
      requestedByRole: actorRole || null,
      detailsJson: { deletedAsset: asset, approvedAuditId: approvedAuditId || null },
      ownerId: (await ownerOrgOfBusiness(asset.businessId)) ?? __authSession.orgId ?? null,
    });

    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
