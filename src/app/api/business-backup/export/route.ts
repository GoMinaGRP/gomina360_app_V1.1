import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { exportBusinessBackup, BACKUP_CONTENT_TYPE } from "@/lib/businessBackup";

/**
 * GET /api/business-backup/export?businessId=12&branchCode=XYZ
 *
 * Stream a restorable JSON/ZIP business backup to the browser.
 * AUTHORIZATION: OWNER always; any other signed-in user must BOTH
 *   (a) have access to the business AND (b) carry the OWNER-granted
 *   can_export_data OR can_create_business flag (owner-delegated
 *   backup/restore authority).
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;

    const url = new URL(request.url);
    const businessId = Number(url.searchParams.get("businessId"));
    const branchCode = url.searchParams.get("branchCode") || null;

    if (!businessId) {
      return NextResponse.json(
        { success: false, error: "businessId query param is required." },
        { status: 400 },
      );
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!biz) {
      return NextResponse.json(
        { success: false, error: "Business not found." },
        { status: 404 },
      );
    }

    const isOwner = user.role === "OWNER";
    const allowed = isOwner
      ? true
      : (user.assignedBusinessId === businessId ||
         (Array.isArray(user.businessManageIds) && user.businessManageIds.includes(businessId)));
    if (!allowed) {
      return FORBIDDEN("You do not have access to this business.");
    }
    const canExport =
      isOwner ||
      user.canExportData === true ||
      user.canCreateBusiness === true ||
      user.businessManageIds?.includes(businessId);
    if (!canExport) {
      return FORBIDDEN("You need an export/backup permission to download business backups.");
    }

    const { zip, fileName } = await exportBusinessBackup({
      businessId,
      branchCode,
      exporter: { userId: user.id, name: user.name, role: user.role },
    });

    return new Response(new Uint8Array(zip) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": BACKUP_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || String(error) },
      { status: 500 },
    );
  }
}
