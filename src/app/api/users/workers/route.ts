import { NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

// BRANCH_MANAGER: List all WORKER accounts within their branch
/** Never expose auth secrets on user rows. */
const stripSecret = (u: any) => {
  const { passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe } = u;
  return { ...safe, hasPassword: Boolean(u.passwordHash) };
};

/** The caller may manage workers inside `businessId`: the Super Admin always;
 *  an org OWNER / GENERAL_MANAGER / BRANCH_MANAGER only with (org-scoped)
 *  access to that business. Mirrors the Users & Access permission matrix. */
async function managerCanScope(user: any, businessId: number): Promise<boolean> {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (!["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(user.role)) return false;
  return canAccessBusiness(user, businessId);
}

export async function GET(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const managerId = searchParams.get("managerId");
    const businessId = searchParams.get("businessId");

    if (!businessId) {
      return NextResponse.json(
        { success: false, error: "businessId query param is required" },
        { status: 400 }
      );
    }

    // Worker accounts live inside business scope; the list is only visible
    // to callers who can access that business — and never with auth secrets.
    if (!(await canAccessBusiness(__authSession.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    const rows = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.role, "WORKER"),
          eq(users.assignedBusinessId, Number(businessId))
        )
      )
      .orderBy(users.id);

    return NextResponse.json({ success: true, workers: rows.map(stripSecret) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// BRANCH_MANAGER: Create a new WORKER account in their branch
export async function POST(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      name,
      email,
      phone,
      assignedBusinessId,
      region,
      district,
      town,
      createdByUserId,
      canRecordSales,
      canRecordExpenses,
      canManageStock,
    } = body;

    if (!name || !email) {
      return NextResponse.json(
        { success: false, error: "Name and email are required to create a Worker account" },
        { status: 400 }
      );
    }

    if (!assignedBusinessId) {
      return NextResponse.json(
        { success: false, error: "Worker must be assigned to a business branch" },
        { status: 400 }
      );
    }

    // Mirror the Users & Access creation matrix: only the OWNER or a
    // GENERAL_MANAGER / BRANCH_MANAGER scope-managing that business may mint
    // a WORKER account — never a plain worker, never for another unit.
    if (!(await managerCanScope(__authSession.user, Number(assignedBusinessId)))) {
      return FORBIDDEN("You can only create workers for businesses you manage.");
    }

    const [newWorker] = await db
      .insert(users)
      .values({
        name,
        email,
        role: "WORKER",
        assignedBusinessId: Number(assignedBusinessId),
        phone: phone || "+233 24 000 0000",
        avatarUrl:
          "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop",
        region: region || null,
        district: district || null,
        town: town || null,
        isActive: true,
        isWorkerEnabled: true,
        createdByUserId: createdByUserId ? Number(createdByUserId) : null,
        canRecordSales: canRecordSales ?? true,
        canRecordExpenses: canRecordExpenses ?? false,
        canManageStock: canManageStock ?? false,
      })
      .returning();

    return NextResponse.json({ success: true, worker: stripSecret(newWorker) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// BRANCH_MANAGER: Enable/disable, update permissions, or delete a WORKER
export async function PATCH(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { workerId, action, canRecordSales, canRecordExpenses, canManageStock } = body;

    if (!workerId) {
      return NextResponse.json(
        { success: false, error: "workerId is required" },
        { status: 400 }
      );
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, Number(workerId)), eq(users.role, "WORKER")));

    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Worker not found" },
        { status: 404 }
      );
    }

    // Only managers of the worker's own business may touch the account —
    // a worker can never toggle flags on colleagues, even in-branch.
    if (!(await managerCanScope(__authSession.user, Number(existing.assignedBusinessId)))) {
      return FORBIDDEN("You can only manage workers inside businesses you manage.");
    }

    if (action === "TOGGLE_ENABLE") {
      const [updated] = await db
        .update(users)
        .set({ isWorkerEnabled: !existing.isWorkerEnabled })
        .where(eq(users.id, Number(workerId)))
        .returning();
      return NextResponse.json({ success: true, worker: stripSecret(updated) });
    }

    if (action === "UPDATE_PERMISSIONS") {
      const [updated] = await db
        .update(users)
        .set({
          canRecordSales: canRecordSales ?? existing.canRecordSales,
          canRecordExpenses: canRecordExpenses ?? existing.canRecordExpenses,
          canManageStock: canManageStock ?? existing.canManageStock,
        })
        .where(eq(users.id, Number(workerId)))
        .returning();
      return NextResponse.json({ success: true, worker: stripSecret(updated) });
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// BRANCH_MANAGER: Delete a WORKER from their branch
export async function DELETE(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const workerId = searchParams.get("workerId");

    if (!workerId) {
      return NextResponse.json(
        { success: false, error: "workerId query param is required" },
        { status: 400 }
      );
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, Number(workerId)), eq(users.role, "WORKER")));

    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Worker not found" },
        { status: 404 }
      );
    }

    // Same manager gate as PATCH: deletion stays inside the caller's scope.
    if (!(await managerCanScope(__authSession.user, Number(existing.assignedBusinessId)))) {
      return FORBIDDEN("You can only remove workers inside businesses you manage.");
    }

    await db.delete(users).where(eq(users.id, Number(workerId)));

    return NextResponse.json({ success: true, deleted: true });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
