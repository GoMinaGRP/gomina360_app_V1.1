import { NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { scenarioSimulations } from "@/db/schema";
import { desc } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { computeScenarioBaseline, computeScenarioImpacts } from "@/lib/scenarioEngine";
import { apiError } from "@/lib/apiError";

export async function GET(request: Request) {
  // Session required: projections carry strategic financial data (enterprise
  // revenue, margins, asset base). Previously readable anonymously.
  const session = await getSessionInfo(request);
  ttlInvalidate("init");
  if (!session) return UNAUTHENTICATED();
  try {
    let rows = await db
      .select()
      .from(scenarioSimulations)
      .orderBy(desc(scenarioSimulations.id));
    // Tenant boundary: normal users see only their own organization's
    // simulations; the Super Admin (isSuperAdmin ⇒ real platform view) sees all.
    if (!session.user.isSuperAdmin) {
      const myOrgs = new Set(session.user.organizationIds || []);
      rows = rows.filter((r: any) => r.ownerId != null && myOrgs.has(Number(r.ownerId)));
    }
    return NextResponse.json({ success: true, scenarios: rows });
  } catch (error: any) {
    return apiError(error);
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

    // Scenario planning is an executive console.
    const scenarioRole = __authSession.user.role;
    if (!__authSession.user.isSuperAdmin && scenarioRole !== "OWNER" && scenarioRole !== "GENERAL_MANAGER") {
      return FORBIDDEN("Scenario planning is reserved for the OWNER and GENERAL_MANAGER.");
    }
    // A targeted simulation must target a business the caller can access.
    if (targetBusinessId && !(await canAccessBusiness(__authSession.user, Number(targetBusinessId)))) {
      return FORBIDDEN("That business belongs to a different organization.");
    }

    // Compute the projected impacts from the REAL baseline: seeded 2026-Q1
    // quarterly close + every live transaction since + live asset register —
    // for the target unit, or the whole REACHABLE scope when untargeted
    // (Super Admin ⇒ whole platform; everyone else ⇒ their own org's units).
    const scopeIds = await accessibleBusinessIds(__authSession.user);
    const baseline = targetBusinessId
      ? await computeScenarioBaseline(Number(targetBusinessId))
      : await computeScenarioBaseline(scopeIds === null ? null : scopeIds);
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
        ownerId: targetBusinessId
          ? (await ownerOrgOfBusiness(Number(targetBusinessId)))
          : (__authSession.orgId ?? null),
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
    return apiError(error);
  }
}
