import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { canSeeFinancials } from "@/lib/permissions";
import { exportBusinessBackup, BACKUP_CONTENT_TYPE } from "@/lib/businessBackup";
import { apiError } from "@/lib/apiError";

// exportBusinessBackup uses Buffer/JSZip; make the supported server runtime
// explicit for both halves of the backup feature.
export const runtime = "nodejs";

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
    // Super Admin ⇒ unrestricted; everyone else (org OWNERs included) only
    // exports businesses inside their own (org-scoped) access list.
    const allowed = user.isSuperAdmin
      ? true
      : await canAccessBusiness(user, businessId);
    if (!allowed) {
      return FORBIDDEN("You do not have access to this business.");
    }
    // ── Download authorisation ──────────────────────────────────────────
    // A business backup is a full-fidelity, RESTORABLE copy of an entire unit:
    // every record, ledger, salary, supplier directory and setting. That is an
    // OWNER-level capability, so it takes an OWNER-issued authorisation —
    // NOT the day-to-day `canExportData` toggle (which a Branch Manager may
    // switch on for a shop worker, and which is meant for list/report exports
    // through the Export Center's request flow).
    const canExport =
      user.isSuperAdmin ||
      isOwner ||
      // Owner-equivalent power over THIS unit (OWNER-granted).
      (user.businessManageIds || []).map(Number).includes(Number(businessId)) ||
      // Trusted to create units AND authorised for the financial data a backup
      // contains (both OWNER-granted).
      (user.canCreateBusiness === true && canSeeFinancials(user));
    if (!canExport) {
      return FORBIDDEN(
        "Downloading a full business backup requires the OWNER (or an account the OWNER authorised to manage this unit).",
      );
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
    return apiError(error);
  }
}
