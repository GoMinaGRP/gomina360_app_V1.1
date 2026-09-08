import { NextResponse } from "next/server";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Asset Code helper.
 *
 *  GET /api/assets/next-code?branchCode=TECH-01
 *      → suggests the next sequential unique code for that branch.
 *
 *  GET /api/assets/next-code?check=TECH-01-AST-0007
 *      → reports whether a specific code is still available.
 */
export async function GET(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const check = searchParams.get("check");
    const branchCode = searchParams.get("branchCode");

    // Availability check for a user-typed code
    if (check) {
      const code = check.trim().toUpperCase();
      const [existing] = await db
        .select()
        .from(assets)
        .where(eq(assets.assetCode, code));
      return NextResponse.json({
        success: true,
        code,
        available: !existing,
      });
    }

    if (!branchCode) {
      return NextResponse.json(
        { success: false, error: "branchCode or check query param is required" },
        { status: 400 }
      );
    }

    const branch = branchCode.trim().toUpperCase();
    const branchAssets = await db
      .select()
      .from(assets)
      .where(eq(assets.branchCode, branch));

    let seq = branchAssets.length + 1;
    let suggestion = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = `${branch}-AST-${String(seq).padStart(4, "0")}`;
      const [exists] = await db
        .select()
        .from(assets)
        .where(eq(assets.assetCode, candidate));
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
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
