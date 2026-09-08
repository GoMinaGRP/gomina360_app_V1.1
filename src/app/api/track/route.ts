import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { customerTrackings, businesses, creditSales, creditPayments } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  looksLikeTrackingCode,
  normalizeTrackingCode,
  publicTrackingPayload,
} from "@/lib/tracking";
import { publicCreditPayload } from "@/lib/credit";

/**
 * PUBLIC customer tracking endpoint — NO login required.
 *
 * The unguessable tracking code IS the access key: it returns only the
 * information linked to that one code (order status timeline, products,
 * business/branch, live dispatch location while in transit). It never
 * reveals customer phone numbers, internal ids, staff names, or anything
 * about other orders. Unknown codes return 404; malformed codes 400.
 */
export async function GET(request: NextRequest) {
  try {
    const code = normalizeTrackingCode(new URL(request.url).searchParams.get("code"));
    if (!code) {
      return NextResponse.json(
        { success: false, error: "Enter your tracking code, e.g. GM-POULTRY-4K7XQ2." },
        { status: 400 },
      );
    }
    if (!looksLikeTrackingCode(code)) {
      return NextResponse.json(
        { success: false, error: "That does not look like a GoMina tracking code. Check the code on your receipt." },
        { status: 400 },
      );
    }

    const [row] = await db
      .select()
      .from(customerTrackings)
      .where(eq(customerTrackings.trackingCode, code));

    if (!row) {
      return NextResponse.json(
        { success: false, error: "No order found for that tracking code." },
        { status: 404 },
      );
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, row.businessId));

    // Credit sale attached to this order? The customer's own code IS the key,
    // so they may see their installment plan, dated payment history and the
    // outstanding balance (amounts/dates only — no staff details).
    let creditPayload: any = null;
    try {
      const [credit] = await db
        .select()
        .from(creditSales)
        .where(eq(creditSales.trackingId, row.id));
      if (credit) {
        const pays = await db
          .select()
          .from(creditPayments)
          .where(eq(creditPayments.creditSaleId, credit.id))
          .orderBy(asc(creditPayments.createdAt));
        creditPayload = publicCreditPayload(credit, pays);
      }
    } catch (creditErr) {
      console.error("GET /api/track credit lookup warning:", creditErr);
    }

    return NextResponse.json(
      { success: true, tracking: publicTrackingPayload(row, biz || null, creditPayload) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("GET /api/track error:", error);
    return NextResponse.json({ success: false, error: "Tracking lookup failed." }, { status: 500 });
  }
}
