import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, userBusinessAccess } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  CATEGORY_ICON,
  nextBusinessCode,
  provisionBusiness,
} from "@/lib/businessProvisioning";
import { resolveOwnerActor } from "@/lib/recordPermissions";
import { getSessionInfo, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    // Session-scoped listing: each user only ever receives the businesses
    // they are assigned / granted access to.
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const allowed = await accessibleBusinessIds(session.user);
    const rows = (await db.select().from(businesses).orderBy(businesses.id)).filter(
      (b) => allowed === null || allowed.includes(b.id)
    );
    return NextResponse.json({ success: true, businesses: rows });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/businesses — create a new enterprise unit AND auto-provision its
 * complete operating workspace (metrics, category starter inventory kit,
 * specialized checklist templates) so its dashboard is fully formed the
 * moment it first opens.
 *
 * AUTHORIZATION: the OWNER always may; any other signed-in user needs the
 * OWNER-granted "New Branch/Unit" permission (users.can_create_business).
 * A non-owner creator automatically receives a user_business_access grant
 * for the unit they created so it appears in their sidebar at once.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    // Session-verified gate (credentials from the secure login cookie —
    // request bodies cannot impersonate). OWNER or canCreateBusiness grant.
    const session = await getSessionInfo(request);
    const actor = session?.user;
    if (!actor) return UNAUTHENTICATED();
    const isOwner = actor.role === "OWNER";
    if (!isOwner && actor.canCreateBusiness !== true) {
      return FORBIDDEN("You need the OWNER-granted New Branch/Unit permission to create new business units.");
    }
    const {
      name,
      code,
      category,
      branchLocation,
      region,
      district,
      town,
      managerName,
      contactPhone,
      initialCapitalGhs,
      monthlyTargetRevenueGhs,
      iconName,
    } = body;

    const resolvedCategory = category || "Other";
    const all = await db.select({ code: businesses.code }).from(businesses);

    // Pretty sequential code per category (BLOCK-02, WASH-02, …). If the caller
    // supplied a code that is already taken, fall back to the next free one.
    let resolvedCode = code && !all.some((b) => b.code === code)
      ? code
      : nextBusinessCode(all.map((b) => b.code), resolvedCategory);

    // Standardized Ghana location: Region → District/MMDA → Town.
    // branchLocation is a derived human-readable summary line.
    const derivedBranchLocation =
      branchLocation ||
      [town, district].filter(Boolean).join(", ") ||
      region ||
      "Accra, Ghana";

    const [newBiz] = await db
      .insert(businesses)
      .values({
        name: name || "New Enterprise Unit",
        code: resolvedCode,
        category: resolvedCategory,
        branchLocation: derivedBranchLocation,
        region: region || "Greater Accra",
        district: district || null,
        town: town || null,
        managerName: managerName || "Assigned Manager",
        contactPhone: contactPhone || "+233 24 000 0000",
        status: "ACTIVE",
        initialCapitalGhs: Number(initialCapitalGhs) || 100000,
        monthlyTargetRevenueGhs: Number(monthlyTargetRevenueGhs) || 50000,
        iconName: iconName || CATEGORY_ICON[resolvedCategory] || "Building2",
      })
      .returning();

    // Auto-provision the full workspace (idempotent per area).
    const provisioned = await provisionBusiness({
      id: newBiz.id,
      code: newBiz.code,
      name: newBiz.name,
      category: newBiz.category,
      initialCapitalGhs: newBiz.initialCapitalGhs,
    });

    // A non-owner creator sees the unit they just created straight away.
    if (!isOwner) {
      const [existing] = await db
        .select({ id: userBusinessAccess.id })
        .from(userBusinessAccess)
        .where(and(eq(userBusinessAccess.userId, actor.id), eq(userBusinessAccess.businessId, newBiz.id)))
        .limit(1);
      if (!existing) {
        await db.insert(userBusinessAccess).values({
          userId: actor.id,
          businessId: newBiz.id,
          createdByUserId: actor.id,
        });
      }
    }

    return NextResponse.json({ success: true, business: newBiz, provisioned });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/businesses { id } — repair/complete provisioning for an existing
 * business (fills in any missing metrics, starter kit or checklist templates).
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const id = Number(body.id || body.businessId);
    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, id));
    if (!biz) {
      return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
    }
    const provisioned = await provisionBusiness({
      id: biz.id,
      code: biz.code,
      name: biz.name,
      category: biz.category,
      initialCapitalGhs: biz.initialCapitalGhs,
    });
    return NextResponse.json({ success: true, business: biz, provisioned });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
