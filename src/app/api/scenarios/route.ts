import { NextResponse } from "next/server";
import { db } from "@/db";
import { scenarioSimulations } from "@/db/schema";
import { desc } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { computeScenarioBaseline, computeScenarioImpacts } from "@/lib/scenarioEngine";

export async function GET(request: Request) {
  // Session required: projections carry strategic financial data (enterprise
  // revenue, margins, asset base). Previously readable anonymously.
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const rows = await db
      .select()
      .from(scenarioSimulations)
      .orderBy(desc(scenarioSimulations.id));
    return NextResponse.json({ success: true, scenarios: rows });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      name,
      description,
      targetBusinessId,
      variableChanged,
      percentChange,
      createdBy,
    } = body;

    const change = Number(percentChange) || 10;
    const variable = variableChanged || "Market Factor";

    // Compute the projected impacts from the REAL baseline: seeded 2026-Q1
    // quarterly close + every live transaction since + live asset register —
    // for the target unit, or the whole enterprise when untargeted.
    const baseline = await computeScenarioBaseline(
      targetBusinessId ? Number(targetBusinessId) : null,
    );
    const impacts = computeScenarioImpacts(variable, change, baseline);

    const [newScenario] = await db
      .insert(scenarioSimulations)
      .values({
        name: name || "Custom Executive What-If Simulation",
        description:
          description ||
          `Simulates the effect of ${percentChange}% adjustment on ${variable}`,
        targetBusinessId: targetBusinessId ? Number(targetBusinessId) : null,
        variableChanged: variable,
        percentChange: change,
        expectedRevenueImpactGhs: impacts.revenueImpact,
        expectedProfitImpactGhs: impacts.profitImpact,
        expectedRoiDelta: impacts.roiDelta,
        createdBy: createdBy || __authSession.user.name || "GoMina 360",
      })
      .returning();

    return NextResponse.json({
      success: true,
      scenario: newScenario,
      // Transparent derivation for the UI ("computed, not guessed").
      basis: impacts.basis,
      baseline: {
        revenueQ: baseline.revenueQ,
        expensesQ: baseline.expensesQ,
        margin: baseline.margin,
        assetsValueQ: baseline.assetsValueQ,
        liveCount: baseline.liveCount,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
