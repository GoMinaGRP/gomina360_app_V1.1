import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, companySettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  canAccessBusiness,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { canManageSharedRecords } from "@/lib/recordPermissions";

/**
 * Company & business logo management.
 *
 * The OWNER — or a manager the OWNER granted record-management permission —
 * uploads/removes: the GoMina company logo (group fallback), each business's
 * logo, and optional per-branch overrides (branch logo wins on that branch's
 * documents; otherwise the business logo; otherwise the company logo).
 *
 * Logos are base64 data-URLs (the app's existing photo convention), resized
 * client-side, saved centrally — so every invoice, receipt, quotation,
 * payslip, report and PDF resolves the same logo everywhere.
 */

const MAX_LEN = 1_800_000; // ~1.35MB base64 (client resizes to ≤512px)

function validLogo(logo: any): logo is string {
  return typeof logo === "string" && logo.startsWith("data:image/") && logo.length <= MAX_LEN;
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const allowed = await accessibleBusinessIds(session.user);
    const rows = (await db.select().from(businesses).orderBy(businesses.id)).filter(
      (b) => allowed === null || allowed.includes(b.id)
    );
    const [cfg] = await db.select().from(companySettings).where(eq(companySettings.id, 1));
    return NextResponse.json({
      success: true,
      companyLogo: cfg?.companyLogo || null,
      businesses: rows.map((b) => ({ id: b.id, name: b.name, code: b.code, logo: b.logo, branchLogos: b.branchLogos || {} })),
      scope: { canManage: canManageSharedRecords(session.user), isOwner: session.user.role === "OWNER" },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    if (user.role !== "OWNER" && !canManageSharedRecords(user)) {
      return FORBIDDEN("Only the OWNER (or an approved manager with record-management permission) can manage logos.");
    }
    const body = await request.json();
    const action = String(body.action || "").toUpperCase();
    const logo = body.logo === null || body.logo === undefined ? null : String(body.logo);
    if (logo && !validLogo(logo)) {
      return NextResponse.json({ success: false, error: "Logo must be an image (PNG/JPG) under about 1MB." }, { status: 400 });
    }

    // ── Company (group) logo — the ultimate fallback ─────────────────────
    if (action === "SET_COMPANY_LOGO") {
      const [cfg] = await db.select().from(companySettings).where(eq(companySettings.id, 1));
      const values = { companyLogo: logo, updatedByUserId: user.id, updatedByName: user.name, updatedByRole: user.role, updatedAt: new Date() };
      let row;
      if (cfg) [row] = await db.update(companySettings).set(values).where(eq(companySettings.id, 1)).returning();
      else [row] = await db.insert(companySettings).values({ id: 1, ...values }).returning();
      return NextResponse.json({ success: true, companyLogo: row.companyLogo });
    }

    // ── Business / branch logos ──────────────────────────────────────────
    const businessId = Number(body.businessId);
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found" }, { status: 404 });
    if (!(await canAccessBusiness(user, businessId))) {
      return FORBIDDEN("That business is outside your access scope.");
    }

    if (action === "SET_BUSINESS_LOGO") {
      const [row] = await db.update(businesses).set({ logo }).where(eq(businesses.id, businessId)).returning();
      return NextResponse.json({ success: true, business: { id: row.id, logo: row.logo } });
    }

    if (action === "SET_BRANCH_LOGO") {
      const branchCode = String(body.branchCode || "").trim().toUpperCase();
      if (!branchCode) return NextResponse.json({ success: false, error: "A branch code is required." }, { status: 400 });
      const map = { ...((biz.branchLogos as any) || {}) };
      if (logo) map[branchCode] = logo;
      else delete map[branchCode]; // removing returns the branch to the business logo
      const [row] = await db.update(businesses).set({ branchLogos: map }).where(eq(businesses.id, businessId)).returning();
      return NextResponse.json({ success: true, business: { id: row.id, branchLogos: row.branchLogos || {} } });
    }

    return NextResponse.json({ success: false, error: "Unknown logo action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
