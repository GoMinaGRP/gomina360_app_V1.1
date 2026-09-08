import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * GET /api/expense-categories?businessId=1&branchCode=POULTRY-01
 */
export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get("businessId");
    const branchCode = searchParams.get("branchCode");

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
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { businessId, branchCode, name, icon, createdBy } = body;

    if (!businessId || !name) {
      return NextResponse.json(
        { success: false, error: "businessId and name are required" },
        { status: 400 }
      );
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
        createdBy: createdBy || "User",
        isActive: true,
      })
      .returning();

    return NextResponse.json({ success: true, category: newCategory });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
