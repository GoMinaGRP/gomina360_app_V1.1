import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  getSessionInfo,
  UNAUTHENTICATED,
  FORBIDDEN,
  canAccessBusiness,
  accessibleBusinessIds,
} from "@/lib/auth";

/**
 * GET /api/expense-categories?businessId=1&branchCode=POULTRY-01
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get("businessId");
    const branchCode = searchParams.get("branchCode");

    // A caller asking for one business must be able to access it.
    if (businessId && !(await canAccessBusiness(session.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // No businessId ⇒ all categories. Non-OWNERs are restricted to the
    // businesses they have been granted access to.
    if (!businessId) {
      const allowed = await accessibleBusinessIds(session.user);
      if (allowed !== null) {
        if (allowed.length === 0) {
          return NextResponse.json({ success: true, categories: [] });
        }
        const categories = await db
          .select()
          .from(expenseCategories)
          .where(inArray(expenseCategories.businessId, allowed));
        categories.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
        return NextResponse.json({ success: true, categories });
      }
    }

    const categories = await (businessId
      ? (branchCode
          ? db.select().from(expenseCategories).where(and(
              eq(expenseCategories.businessId, Number(businessId)),
              eq(expenseCategories.branchCode, branchCode)
            ))
          : db.select().from(expenseCategories).where(eq(expenseCategories.businessId, Number(businessId))))
      : db.select().from(expenseCategories));

    categories.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    return NextResponse.json({ success: true, categories });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/expense-categories
 * Create a new custom expense category.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const body = await request.json();
    const { businessId, branchCode, name, icon, createdBy } = body;

    if (!businessId || !name) {
      return NextResponse.json(
        { success: false, error: "businessId and name are required" },
        { status: 400 }
      );
    }

    // Only users who can access the business may add expense categories for it.
    if (!(await canAccessBusiness(session.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to record categories for that business.");
    }

    // Check if category already exists
    const [existing] = await db
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.name, name.trim()));

    if (existing) {
      return NextResponse.json(
        { success: false, error: `Category "${name}" already exists` },
        { status: 409 }
      );
    }

    const [newCategory] = await db
      .insert(expenseCategories)
      .values({
        businessId: Number(businessId),
        branchCode: branchCode || null,
        name: name.trim(),
        icon: icon || null,
        createdBy: session.user.name || createdBy || "User",
        isActive: true,
      })
      .returning();

    return NextResponse.json({ success: true, category: newCategory });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
