import { NextRequest, NextResponse } from "next/server";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { lowStockItemsForBusiness, sweepLowStockForBusiness } from "@/lib/lowStock";

/**
 * Low-stock radar (P3) — reads the existing inventory register, never a
 * second stock table.
 *
 *  GET  ?businessId=… — the items currently at/below their reorder point in
 *      one business (any business the caller may access). Used by the
 *      Inventory view's reorder banner.
 *  POST ?businessId=… — run the sweep NOW for one business (or ?all=1 for
 *      every business in the caller's scope): normalizes item statuses and
 *      drops today's deduped reorder alert on the branch team's bell.
 *      Managers/owner only.
 */

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    if (!(await canAccessBusiness(session.user, businessId))) {
      return FORBIDDEN("That business is outside your scope.");
    }
    const items = await lowStockItemsForBusiness(businessId);
    return NextResponse.json({
      success: true,
      businessId,
      items,
      lowCount: items.filter((i: any) => i.severity === "LOW").length,
      outCount: items.filter((i: any) => i.severity === "OUT").length,
    });
  } catch (e) {
    console.error("[api/low-stock GET]", e);
    return NextResponse.json({ success: false, error: "Could not read the stock radar." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const role = String(user.role || "").toUpperCase();
    const isManager =
      role === "OWNER" ||
      role === "GENERAL_MANAGER" ||
      role === "BRANCH_MANAGER" ||
      !!user.isSuperAdmin ||
      (Array.isArray(user.businessManageIds) && user.businessManageIds.length > 0);
    if (!isManager) return FORBIDDEN("Only managers can trigger the stock sweep.");

    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all") === "1";
    const businessId = Number(searchParams.get("businessId"));
    if (!all && !businessId) {
      return NextResponse.json({ success: false, error: "businessId or all=1 required" }, { status: 400 });
    }
    if (all) {
      const allowed = await accessibleBusinessIds(user);
      const ids = allowed === null ? null : allowed;
      if (ids != null && ids.length === 0) {
        return NextResponse.json({ success: true, results: [], note: "No businesses in your scope." });
      }
      const { sweepLowStock } = await import("@/lib/lowStock");
      const results = await sweepLowStock(ids, { actorName: user.name });
      return NextResponse.json({ success: true, results });
    }
    if (!(await canAccessBusiness(user, businessId))) {
      return FORBIDDEN("That business is outside your scope.");
    }
    const result = await sweepLowStockForBusiness(businessId, { actorName: user.name });
    return NextResponse.json({ success: true, result });
  } catch (e) {
    console.error("[api/low-stock POST]", e);
    return NextResponse.json({ success: false, error: "Could not run the stock sweep." }, { status: 500 });
  }
}
