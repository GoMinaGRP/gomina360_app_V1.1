import { NextResponse } from "next/server";
import { db } from "@/db";
import { customerSupportInfo } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Group-wide CUSTOMER SUPPORT information — the content of the storefront's
 * HELP panel (contact name, phone, WhatsApp, email, business address /
 * location, opening hours, and any other important support notes).
 *
 * GET  — PUBLIC (no login): shoppers read it when they tap HELP on the
 *        customer order page.
 * POST — OWNER, or a user the OWNER explicitly granted the "Customer
 *        Support — storefront HELP" permission (can_manage_support):
 *        creates or updates the single live row.
 */

const LIMITS: Record<string, number> = {
  contactName: 120,
  phone: 40,
  whatsapp: 40,
  email: 160,
  address: 300,
  openingHours: 200,
  extraInfo: 1000,
};

function clean(value: any, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s === "" ? null : s;
}

export async function GET() {
  try {
    const [row] = await db
      .select()
      .from(customerSupportInfo)
      .where(eq(customerSupportInfo.id, 1));
    return NextResponse.json(
      {
        success: true,
        info: row
          ? {
              contactName: row.contactName,
              phone: row.phone,
              whatsapp: row.whatsapp,
              email: row.email,
              address: row.address,
              openingHours: row.openingHours,
              extraInfo: row.extraInfo,
              updatedByName: row.updatedByName,
              updatedAt: row.updatedAt,
            }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("GET /api/support-info error:", error);
    return NextResponse.json(
      { success: false, error: "Could not load support information." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const isOwner = user.role === "OWNER";
    if (!isOwner && !user.canManageSupport) {
      return FORBIDDEN(
        "Only the OWNER — or a user the OWNER granted Customer Support access — can edit the storefront HELP information.",
      );
    }

    const body = await request.json().catch(() => ({}));
    const values = {
      contactName: clean(body.contactName, LIMITS.contactName),
      phone: clean(body.phone, LIMITS.phone),
      whatsapp: clean(body.whatsapp, LIMITS.whatsapp),
      email: clean(body.email, LIMITS.email),
      address: clean(body.address, LIMITS.address),
      openingHours: clean(body.openingHours, LIMITS.openingHours),
      extraInfo: clean(body.extraInfo, LIMITS.extraInfo),
      updatedByUserId: user.id,
      updatedByName: user.name,
      updatedByRole: user.role,
      updatedAt: new Date(),
    };
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      return NextResponse.json(
        { success: false, error: "That email address does not look valid." },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select({ id: customerSupportInfo.id })
      .from(customerSupportInfo)
      .where(eq(customerSupportInfo.id, 1));
    let row;
    if (existing) {
      [row] = await db
        .update(customerSupportInfo)
        .set(values)
        .where(eq(customerSupportInfo.id, 1))
        .returning();
    } else {
      [row] = await db
        .insert(customerSupportInfo)
        .values({ id: 1, ...values })
        .returning();
    }

    return NextResponse.json({
      success: true,
      info: {
        contactName: row.contactName,
        phone: row.phone,
        whatsapp: row.whatsapp,
        email: row.email,
        address: row.address,
        openingHours: row.openingHours,
        extraInfo: row.extraInfo,
        updatedByName: row.updatedByName,
        updatedAt: row.updatedAt,
      },
    });
  } catch (error: any) {
    console.error("POST /api/support-info error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Could not save support information." },
      { status: 500 },
    );
  }
}
