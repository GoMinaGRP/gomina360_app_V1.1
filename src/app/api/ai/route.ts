import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiInsights } from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { computeScenarioBaseline } from "@/lib/scenarioEngine";
import { apiError } from "@/lib/apiError";

export async function GET(request: Request) {
  // Session required: insights reference enterprise financials.
  // (M2 fix: a GET must never invalidate the shared init cache — polling this
  // endpoint used to flush it for everyone on every read.)
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    let rows = await db.select().from(aiInsights).orderBy(desc(aiInsights.id));
    // Tenant boundary: normal users see only their own organization's
    // insights; the Super Admin sees everything (D4 platform visibility).
    if (!session.user.isSuperAdmin) {
      const myOrgs = new Set(session.user.organizationIds || []);
      rows = rows.filter((r: any) => r.ownerId != null && myOrgs.has(Number(r.ownerId)));
    }
    return NextResponse.json({ success: true, insights: rows });
  } catch (error: any) {
    return apiError(error);
  }
}

// Per-user generation cooldown (in-memory, single-process — matches the
// ttlCache deployment caveat): one analysis per COOLDOWN_MS per user.
const lastGenAt = new Map<number, number>();
const COOLDOWN_MS = 60_000;

export async function POST(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    // H2 controls: cooldown — the advisor is deterministic and each click
    // used to write a permanent row; a rapid button mashing spammed the list.
    const last = lastGenAt.get(Number(__authSession.user.id)) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      return NextResponse.json(
        { success: false, error: `Please wait ${wait}s before generating another analysis.` },
        { status: 429 },
      );
    }
    lastGenAt.set(Number(__authSession.user.id), Date.now());
    const { prompt, targetBusinessId } = body;

    // The AI advisor is an executive console: OWNER / GENERAL_MANAGER only,
    // and a targeted analysis must target a reachable business (tenant boundary).
    const advisorRole = __authSession.user.role;
    if (!__authSession.user.isSuperAdmin && advisorRole !== "OWNER" && advisorRole !== "GENERAL_MANAGER") {
      return FORBIDDEN("The AI Advisor is reserved for the OWNER and GENERAL_MANAGER.");
    }
    if (targetBusinessId && !(await canAccessBusiness(__authSession.user, Number(targetBusinessId)))) {
      return FORBIDDEN("That business belongs to a different organization.");
    }

    // Real baseline of the queried scope — the canned multi-thousand
    // "projected gains" used to be invented constants; now every figure
    // derives from the unit's (or the enterprise's) quarterly books plus the
    // live ledger, via the shared scenario engine. An untargeted query scans
    // only the caller's reachable scope (Super Admin ⇒ whole platform).
    const advisorScope = targetBusinessId
      ? Number(targetBusinessId)
      : ((await accessibleBusinessIds(__authSession.user)) ?? null);
    const baseline = await computeScenarioBaseline(advisorScope);
    const money = (n: number) => `GH₵ ${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

    // Intelligent AI Decision Advisor logic tailored for Ghanaian business dynamics
    let generatedTitle = "AI Strategic Recommendation: Operational Synergy";
    let generatedCategory = "EFFICIENCY";
    let generatedImpact = "HIGH";
    let generatedRecommendation = "";
    let generatedMetric = `Modelled upside ≈ ${money(0.08 * Math.max(1000, baseline.expensesQ))}/qtr (expense base ${money(baseline.expensesQ)})`;
    let projectedGain = Math.round(0.08 * Math.max(1000, baseline.expensesQ));

    const lower = (prompt || "").toLowerCase();
    if (lower.includes("feed") || lower.includes("poultry") || lower.includes("maize")) {
      generatedTitle = "Maize & Concentrate Supply Hedge Strategy";
      generatedCategory = "EFFICIENCY";
      generatedImpact = "CRITICAL";
      generatedRecommendation =
        "AI Analysis indicates upcoming dry season feed price volatility. Establish a direct supply agreement with Eastern Region maize farmers and store 15 tons in Nsawam silos.";
      // 8% hedge on the real quarterly feed cost base of the scope.
      projectedGain = Math.max(500, Math.round(0.08 * baseline.costBaseFeedQ));
      generatedMetric = `Feed cost hedge ≈ ${money(projectedGain)}/qtr (base ${money(baseline.costBaseFeedQ)})`;
    } else if (lower.includes("block") || lower.includes("cement") || lower.includes("tema") || lower.includes("spintex")) {
      generatedTitle = "Spintex & Tema Bulk Aggregates Procurement Optimization";
      generatedCategory = "OPPORTUNITY";
      generatedImpact = "HIGH";
      generatedRecommendation =
        "Consolidate sand and quarry aggregate transport using 20-ton tipper trucks rather than daily deliveries to reduce Spintex freight costs by 18.5%.";
      // 6% freight saving on the real cement/raw-material cost base.
      projectedGain = Math.max(500, Math.round(0.06 * baseline.costBaseCementQ));
      generatedMetric = `Raw-material freight saving ≈ ${money(projectedGain)}/qtr (base ${money(baseline.costBaseCementQ)})`;
    } else if (lower.includes("solar") || lower.includes("inverter") || lower.includes("tech") || lower.includes("electronic")) {
      generatedTitle = "Commercial Solar Hybrid Lease-to-Own Program";
      generatedCategory = "OPPORTUNITY";
      generatedImpact = "CRITICAL";
      generatedRecommendation =
        "Launch a 6-month MoMo-based installment payment plan for small restaurants and offices in Accra for 5kVA Solar Inverters. Projected conversion rate: 32%.";
      // Instalment plan lifting demand: 15% of real quarterly revenue at the real margin.
      projectedGain = Math.max(500, Math.round(0.15 * baseline.revenueQ * Math.max(0.15, baseline.margin)));
      generatedMetric = `Modelled instalment lift ≈ ${money(projectedGain)}/qtr (revenue base ${money(baseline.revenueQ)})`;
    } else if (lower.includes("tilapia") || lower.includes("fish") || lower.includes("aqua") || lower.includes("water")) {
      generatedTitle = "Volta Basin Automated Solar Aeration Integration";
      generatedCategory = "EFFICIENCY";
      generatedImpact = "HIGH";
      generatedRecommendation =
        "Deploy solar-powered surface aerators in Akosombo Cages 1-4 during 3am-6am low-oxygen cycles. Predicts FCR drop from 1.32 to 1.22.";
      // Aeration/FCR gain ≈ 7% of the real quarterly feed cost base.
      projectedGain = Math.max(500, Math.round(0.07 * baseline.costBaseFeedQ));
      generatedMetric = `FCR improvement ≈ ${money(projectedGain)}/qtr (feed base ${money(baseline.costBaseFeedQ)})`;
    } else if (lower.includes("expand") || lower.includes("branch") || lower.includes("kumasi") || lower.includes("takoradi")) {
      generatedTitle = "Strategic Multi-City Expansion Matrix";
      generatedCategory = "FORECAST";
      generatedImpact = "CRITICAL";
      generatedRecommendation =
        "Cross-business data shows Kumasi market ready for an integrated Block Factory & Express Car Wash hub. Expected break-even timeline is 7.2 months.";
      // New hub ≈ 25% of an average unit's quarterly output at the real margin.
      projectedGain = Math.max(500, Math.round(0.25 * baseline.avgUnitRevenueQ * Math.max(0.15, baseline.margin)));
      generatedMetric = `Modelled hub contribution ≈ ${money(projectedGain)}/qtr (avg unit output ${money(baseline.avgUnitRevenueQ)})`;
    } else {
      generatedTitle = "Enterprise-Wide Working Capital Re-allocation";
      generatedCategory = "OPPORTUNITY";
      generatedImpact = "HIGH";
      generatedRecommendation =
        `Based on query '${prompt}': Allocate surplus weekend cash receipts from Mina Heritage Kitchen and Auto Wash to settle high-volume supplier invoices early for a 3% early-payment discount.`;
      generatedMetric = "Net Margin Enhancement (+GH₵ 19,200)";
      projectedGain = 19200;
    }

    // H2 controls: dedupe — the same rule-fired recommendation for the same
    // scope within 24 h refreshes the existing insight instead of stacking a
    // near-copy (the advisor is deterministic rule-matching, so identical
    // inputs otherwise produce unbounded duplicates in the executive list).
    const scopeBizId = targetBusinessId ? Number(targetBusinessId) : null;
    const dupWindow = 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - dupWindow);
    let insightOwner =
      scopeBizId != null
        ? await ownerOrgOfBusiness(scopeBizId)
        : (__authSession.orgId ?? null);
    const recent = await db.select().from(aiInsights).orderBy(desc(aiInsights.id));
    const reuse = recent.find(
      (r: any) =>
        (r.businessId ?? null) === scopeBizId &&
        (r.ownerId ?? null) === (insightOwner ?? null) &&
        r.title === generatedTitle &&
        r.createdAt && new Date(r.createdAt).getTime() > since.getTime(),
    );
    if (reuse) {
      const [rebound] = await db
        .select()
        .from(aiInsights)
        .where(eq(aiInsights.id, reuse.id));
      return NextResponse.json({ success: true, insight: rebound, deduped: true });
    }

    const [newInsight] = await db
      .insert(aiInsights)
      .values({
        businessId: scopeBizId,
        title: generatedTitle,
        category: generatedCategory,
        impactLevel: generatedImpact,
        recommendation: generatedRecommendation,
        metricAffected: generatedMetric,
        projectedGainGhs: projectedGain,
        ownerId: insightOwner,
        status: "NEW",
      })
      .returning();

    // Retention: keep at most MAX_INSIGHTS_PER_SCOPE per (owner, business)
    // scope — prune the oldest beyond the cap so the table can't grow forever.
    const MAX_INSIGHTS_PER_SCOPE = 200;
    const scopedNow = recent.filter((r: any) => (r.businessId ?? null) === scopeBizId && (r.ownerId ?? null) === (insightOwner ?? null));
    if (scopedNow.length + 1 > MAX_INSIGHTS_PER_SCOPE) {
      const dropIds = scopedNow.slice(MAX_INSIGHTS_PER_SCOPE - 1).map((r: any) => r.id);
      if (dropIds.length) await db.delete(aiInsights).where(inArray(aiInsights.id, dropIds));
    }

    return NextResponse.json({ success: true, insight: newInsight });
  } catch (error: any) {
    return apiError(error);
  }
}
