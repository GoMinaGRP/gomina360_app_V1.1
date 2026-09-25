/**
 * Farm Advisor — read-only farm data feed.
 *
 * GET ?businessId=&windowDays=
 *   Returns exactly what the caller's grant allows: flocks, feed, water,
 *   health, production, weights, checklist compliance, staff daily notes,
 *   live poultry alerts (lib/poultryAnalytics), benchmark performance
 *   (lib/poultryPerformance) and the Advisory Digest (lib/advisorAi).
 *
 * Money is stripped server-side unless the grant enables COSTS, and every
 * collection is narrowed to the granted branch and flocks. Owners/managers may
 * call it too (they see their normal scope) so the Owner "Advisory" view and
 * the Advisor workspace render from ONE code path.
 */

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { businesses, dailyNotes, inventoryItems, transactions } from "@/db/schema";
import { canAccessBusiness, getSessionInfo, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import {
  advisorGrantFor,
  grantHasScope,
  isAdvisor,
  stripMoneyRows,
  type AdvisorGrant,
} from "@/lib/advisorAccess";
import { generateDigest, loadFarmData, scopeFarmDataToGrant } from "@/lib/advisorServer";
import { analyzePoultry } from "@/lib/poultryAnalytics";
import { computePoultryPerformance } from "@/lib/poultryPerformance";
import { apiError } from "@/lib/apiError";

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const { searchParams } = new URL(request.url);
    const businessId = Number(searchParams.get("businessId"));
    const windowDays = Number(searchParams.get("windowDays")) || 30;
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that farm.");

    const advisor = isAdvisor(me);
    const grant: AdvisorGrant | null = advisor ? await advisorGrantFor(me, businessId) : null;
    if (advisor && !grant) return FORBIDDEN("Your advisory access to this farm is not active.");

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    const raw = await loadFarmData(businessId);
    const data = grant ? scopeFarmDataToGrant(raw, grant) : raw;
    const showCosts = !advisor || !!grant?.showCosts;

    // Staff daily notes give the advisor context (never money).
    const notes = grant && !grantHasScope(grant, "DAILY_NOTES")
      ? []
      : await db.select().from(dailyNotes).where(eq(dailyNotes.businessId, businessId));

    // Inventory levels (quantities; costs only when the grant allows).
    const inventory = grant && !grantHasScope(grant, "INVENTORY_LEVELS")
      ? []
      : showCosts
        ? await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId))
        : stripMoneyRows(await db.select().from(inventoryItems).where(eq(inventoryItems.businessId, businessId)));

    // Alerts + performance reuse the dashboard's own analytics engines, so the
    // advisor reads EXACTLY the numbers the Owner sees — never a second truth.
    const analysis = analyzePoultry({
      flocks: data.flocks,
      feedLogs: data.feedLogs,
      waterLogs: data.waterLogs,
      healthRecords: data.healthRecords,
      production: data.production,
      checklists: data.checklistEntries,
      inventory,
      transactions: showCosts ? await db.select().from(transactions).where(eq(transactions.businessId, businessId)) : [],
      currentCurrency: "GHS",
    });

    const performance = computePoultryPerformance(
      {
        flocks: data.flocks,
        feedLogs: data.feedLogs,
        production: data.production,
        weightLogs: data.weightLogs,
        healthRecords: data.healthRecords,
      } as any,
      { dateFilter: "ALL", productFilter: "ALL", batchNumber: "ALL", flockId: null, branchCode: "ALL" },
    );

    const digest = await generateDigest(businessId, { windowDays, grant });

    return NextResponse.json({
      success: true,
      business: biz ? { id: biz.id, name: biz.name, code: biz.code, branchLocation: biz.branchLocation, category: biz.category } : null,
      grant: grant
        ? {
            scopes: grant.scopes,
            branchCode: grant.branchCode,
            flockIds: grant.flockIds,
            showCosts: grant.showCosts,
            canExport: grant.canExport,
            startsOn: grant.startsOn,
            endsOn: grant.endsOn,
          }
        : null,
      showCosts,
      ...data,
      dailyNotes: notes,
      inventory,
      alerts: analysis.alerts,
      healthScore: analysis.healthScore,
      statusColor: analysis.statusColor,
      metrics: analysis.metrics,
      performance,
      digest,
    });
  } catch (error: any) {
    return apiError(error);
  }
}
