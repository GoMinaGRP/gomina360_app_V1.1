import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets, businesses } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED, canAccessBusiness, accessibleBusinessIds } from "@/lib/auth";
import { apiError } from "@/lib/apiError";

/**
 * Asset Code helper.
 *
 *  GET /api/assets/next-code?branchCode=TECH-01&businessId=7
 *      → suggests the next sequential unique code for that branch.
 *
 *  GET /api/assets/next-code?check=TECH-01-AST-0007&businessId=7
 *      → reports whether a specific code is still available.
 *
 * TENANT SCOPING: asset codes number PER BUSINESS (each unit's registry starts
 * at BRANCH-AST-0001) — two independent organizations may both run a POULTRY-01
 * unit with its own AST-0001. Every count/probe is therefore scoped to the
 * caller's accessible businesses: the explicit `businessId` when the client
 * sends one, otherwise every accessible business carrying that branch code.
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const check = searchParams.get("check");
    const branchCode = searchParams.get("branchCode");
    const businessIdRaw = Number(searchParams.get("businessId"));

    let scopeIds: number[] = [];
    if (Number.isFinite(businessIdRaw) && businessIdRaw > 0) {
      if (!(await canAccessBusiness(session.user, businessIdRaw))) {
        return NextResponse.json(
          { success: false, error: "You do not have access to that business." },
          { status: 403 }
        );
      }
      scopeIds = [businessIdRaw];
    } else {
      // Legacy client (no businessId): every accessible business that matches
      // the branch code — for a bare `check` call, the caller's whole world.
      const allowed = await accessibleBusinessIds(session.user); // null ⇒ super admin
      const matches = await db
        .select({ id: businesses.id })
        .from(businesses)
        .where(branchCode ? eq(businesses.code, branchCode.trim().toUpperCase()) : undefined);
      scopeIds = matches
        .map((m) => Number(m.id))
        .filter((id) => allowed === null || allowed.includes(id));
    }
    const inScope = scopeIds.length ? inArray(assets.businessId, scopeIds) : undefined;

    // Availability check for a user-typed code (within the caller's scope).
    if (check) {
      const code = check.trim().toUpperCase();
      const existing = inScope
        ? await db.select({ id: assets.id }).from(assets).where(and(eq(assets.assetCode, code), inScope))
        : [];
      return NextResponse.json({
        success: true,
        code,
        available: existing.length === 0,
      });
    }

    if (!branchCode) {
      return NextResponse.json(
        { success: false, error: "branchCode or check query param is required" },
        { status: 400 }
      );
    }

    const branch = branchCode.trim().toUpperCase();
    const branchAssets = inScope
      ? await db.select().from(assets).where(inScope)
      : [];

    let seq = branchAssets.length + 1;
    let suggestion = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = `${branch}-AST-${String(seq).padStart(4, "0")}`;
      const [exists] = inScope
        ? await db.select().from(assets).where(and(eq(assets.assetCode, candidate), inScope))
        : [];
      if (!exists) {
        suggestion = candidate;
        break;
      }
      seq += 1;
    }

    return NextResponse.json({
      success: true,
      branchCode: branch,
      suggestion,
      existingCount: branchAssets.length,
    });
  } catch (error: any) {
    return apiError(error);
  }
}
