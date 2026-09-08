import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { universalExports, users, businesses } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

async function getUser(userId: number) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user;
}

function isExecutive(role?: string | null) {
  return role === "OWNER" || role === "GENERAL_MANAGER";
}

/**
 * GET /api/exports?userId=1
 * Owner/GM see all audit history; Branch Managers see their branch; Workers see only their requests.
 */
export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const userId = Number(searchParams.get("userId"));
    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const user = await getUser(userId);
    if (!user) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    let rows = await db.select().from(universalExports).orderBy(desc(universalExports.id));
    if (user.role === "WORKER") {
      rows = rows.filter((r) => r.requesterUserId === user.id);
    } else if (user.role === "BRANCH_MANAGER") {
      rows = rows.filter((r) => r.businessId === user.assignedBusinessId);
    }

    return NextResponse.json({ success: true, exports: rows });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/exports
 * Permission model:
 *   OWNER / GENERAL_MANAGER: direct export, all businesses.
 *   BRANCH_MANAGER: direct export IF canExportData is true, scoped to assigned branch.
 *   WORKER: creates PENDING request regardless of canExportData (requires approval).
 */
export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      exportId,
      moduleKey,
      moduleLabel,
      exportType,
      format,
      requesterUserId,
      businessId,
      businessName,
      branchCode,
      branchName,
      filtersJson,
      recordCount,
      qrCodeData,
      qrCodePayload,
      status: requestedStatus,
    } = body;

    if (!exportId || !moduleKey || !format || !requesterUserId) {
      return NextResponse.json(
        { success: false, error: "exportId, moduleKey, format and requesterUserId are required" },
        { status: 400 }
      );
    }

    const user = await getUser(Number(requesterUserId));
    if (!user) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    // ── Permission gate ─────────────────────────────────────────────
    if (!isExecutive(user.role)) {
      // Branch Managers must have canExportData=true for direct export.
      // Workers always create pending requests but still need canExportData
      // to be eligible to submit at all.
      if (user.canExportData === false) {
        return NextResponse.json(
          {
            success: false,
            error:
              user.role === "WORKER"
                ? "Your account does not have export permission. Please ask your Branch Manager to enable export access."
                : "Export permission has not been granted for your account. Please contact the Owner or General Manager.",
          },
          { status: 403 }
        );
      }
    }

    let scopedBusinessId = businessId ? Number(businessId) : null;
    let scopedBusinessName = businessName || null;
    let scopedBranchCode = branchCode || null;
    let scopedBranchName = branchName || null;

    // Branch Managers and Workers can only export their assigned business/branch.
    if (user.role === "BRANCH_MANAGER" || user.role === "WORKER") {
      scopedBusinessId = user.assignedBusinessId;
      const [biz] = scopedBusinessId
        ? await db.select().from(businesses).where(eq(businesses.id, scopedBusinessId))
        : [];
      scopedBusinessName = biz?.name || null;
      scopedBranchCode = biz?.code || null;
      scopedBranchName = biz?.name || null;
    }

    // Workers always need approval, regardless of requested status.
    // Branch Managers with permission export directly (COMPLETED).
    const status = user.role === "WORKER" ? "PENDING" : requestedStatus || "COMPLETED";

    const [row] = await db
      .insert(universalExports)
      .values({
        exportId,
        moduleKey,
        moduleLabel: moduleLabel || moduleKey,
        exportType: exportType || "REPORT",
        format,
        status,
        requesterUserId: user.id,
        requesterName: user.name,
        requesterRole: user.role,
        businessId: scopedBusinessId,
        businessName: scopedBusinessName,
        branchCode: scopedBranchCode,
        branchName: scopedBranchName,
        filtersJson: filtersJson || {},
        recordCount: Number(recordCount) || 0,
        qrCodeData: qrCodeData || null,
        qrCodePayload: qrCodePayload || null,
        completedAt: status === "COMPLETED" ? new Date() : null,
      })
      .returning();

    return NextResponse.json({ success: true, export: row });
  } catch (error: any) {
    const status = String(error?.message || "").includes("unique") ? 409 : 500;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }
}

/**
 * PATCH /api/exports
 * APPROVE / REJECT by Owner/GM; COMPLETE after an approved Worker download.
 */
export async function PATCH(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { id, action, actorUserId, qrCodeData, qrCodePayload, recordCount } = body;
    if (!id || !action || !actorUserId) {
      return NextResponse.json({ success: false, error: "id, action and actorUserId required" }, { status: 400 });
    }

    const actor = await getUser(Number(actorUserId));
    if (!actor) return NextResponse.json({ success: false, error: "Actor not found" }, { status: 404 });

    const [existing] = await db.select().from(universalExports).where(eq(universalExports.id, Number(id)));
    if (!existing) return NextResponse.json({ success: false, error: "Export record not found" }, { status: 404 });

    if (action === "APPROVE" || action === "REJECT") {
      if (!isExecutive(actor.role)) {
        return NextResponse.json({ success: false, error: "Only Owner or General Manager can approve exports" }, { status: 403 });
      }
      const [updated] = await db
        .update(universalExports)
        .set({
          status: action === "APPROVE" ? "APPROVED" : "REJECTED",
          approvedByUserId: actor.id,
          approvedByName: actor.name,
          approvedAt: new Date(),
        })
        .where(eq(universalExports.id, existing.id))
        .returning();
      return NextResponse.json({ success: true, export: updated });
    }

    if (action === "COMPLETE") {
      if (actor.id !== existing.requesterUserId && !isExecutive(actor.role)) {
        return NextResponse.json({ success: false, error: "Not permitted" }, { status: 403 });
      }
      if (existing.requesterRole === "WORKER" && existing.status !== "APPROVED") {
        return NextResponse.json({ success: false, error: "Worker export has not been approved" }, { status: 403 });
      }
      const [updated] = await db
        .update(universalExports)
        .set({
          status: "COMPLETED",
          qrCodeData: qrCodeData || existing.qrCodeData,
          qrCodePayload: qrCodePayload || existing.qrCodePayload,
          recordCount: Number(recordCount) || existing.recordCount,
          completedAt: new Date(),
        })
        .where(eq(universalExports.id, existing.id))
        .returning();
      return NextResponse.json({ success: true, export: updated });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
