import { NextResponse } from "next/server";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { computeScenarioBaseline, computeScenarioImpacts } from "@/lib/scenarioEngine";

/**
 * Live what-if sandbox — the Scenario Planner slider calls this (debounced)
 * so the on-screen projection is computed from the SAME real baseline as a
 * saved simulation: quarterly revenue/expenses, live transaction overlay,
 * real margin, and the asset register.
 */
export async function GET(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const url = new URL(request.url);
    const variable = url.searchParams.get("variable") || "Market Factor";
    const pct = Number(url.searchParams.get("pct")) || 0;
    const bizParam = url.searchParams.get("businessId");
    const businessId = bizParam && Number(bizParam) > 0 ? Number(bizParam) : null;

    const baseline = await computeScenarioBaseline(businessId);
    const impacts = computeScenarioImpacts(variable, pct, baseline);

    return NextResponse.json({
      success: true,
      variable,
      pct,
      impacts,
      baseline: {
        scope: baseline.scope,
        businessId: baseline.businessId,
        revenueQ: baseline.revenueQ,
        expensesQ: baseline.expensesQ,
        profitQ: baseline.profitQ,
        margin: baseline.margin,
        assetsValueQ: baseline.assetsValueQ,
        monthlyRevenue: baseline.monthlyRevenue,
        monthlyExpenses: baseline.monthlyExpenses,
        liveCount: baseline.liveCount,
        liveIncomeQ: baseline.liveIncomeQ,
        liveExpenseQ: baseline.liveExpenseQ,
        avgUnitRevenueQ: baseline.avgUnitRevenueQ,
        costBaseFeedQ: baseline.costBaseFeedQ,
        costBaseCementQ: baseline.costBaseCementQ,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
