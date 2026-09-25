/**
 * Farm Advisor — Advisory Digest.
 *
 *   GET  ?businessId=&windowDays=  → compute and return the digest
 *   POST { businessId, windowDays, publish }
 *        → compute it and PUBLISH it to the existing AI Insights feed
 *          (ai_insights), so the Owner reads advisory conclusions in the AI
 *          Advisor view they already use. Rate-limited like /api/ai.
 */
import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiInsights } from "@/db/schema";
import { canAccessBusiness, getSessionInfo, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import { advisorGrantFor, isAdvisor } from "@/lib/advisorAccess";
import { advisoryRecipients, generateDigest, notifyUsers } from "@/lib/advisorServer";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";

const lastGenAt = new Map<number, number>();
const COOLDOWN_MS = 30_000;

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
    const grant = isAdvisor(me) ? await advisorGrantFor(me, businessId) : null;
    if (isAdvisor(me) && !grant) return FORBIDDEN("Your advisory access to this farm is not active.");
    const digest = await generateDigest(businessId, { windowDays, grant });
    return NextResponse.json({ success: true, digest });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const last = lastGenAt.get(Number(me.id)) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      return NextResponse.json({ success: false, error: `Please wait ${wait}s before generating another digest.` }, { status: 429 });
    }
    lastGenAt.set(Number(me.id), Date.now());

    const body = await request.json();
    const businessId = Number(body.businessId);
    const windowDays = Number(body.windowDays) || 30;
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required" }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that farm.");
    const grant = isAdvisor(me) ? await advisorGrantFor(me, businessId) : null;
    if (isAdvisor(me) && !grant) return FORBIDDEN("Your advisory access to this farm is not active.");

    const digest = await generateDigest(businessId, { windowDays, grant });

    if (body.publish !== false) {
      await db.insert(aiInsights).values({
        businessId,
        title: `Advisory Digest — ${digest.headline}`.slice(0, 200),
        category: digest.severity === "URGENT" ? "RISK" : digest.severity === "WATCH" ? "COMPLIANCE" : "EFFICIENCY",
        impactLevel: digest.severity === "URGENT" ? "CRITICAL" : digest.severity === "WATCH" ? "HIGH" : "MEDIUM",
        recommendation: [digest.summary, ...digest.recommendations].join(" "),
        metricAffected: digest.metrics
          .filter((m) => m.actual != null)
          .map((m) => `${m.label}: ${m.actual}${m.unit} (target ${m.target}${m.unit})`)
          .join(" · ")
          .slice(0, 480) || "Farm benchmarks",
        projectedGainGhs: 0,
        status: "NEW",
        ownerId: await ownerOrgOfBusiness(businessId),
      });
      await notifyUsers(await advisoryRecipients(businessId, digest.severity === "URGENT" ? "HIGH" : "MEDIUM", [me.id]), {
        type: "ADVISOR_DIGEST_READY",
        title: `Advisory digest: ${digest.headline}`.slice(0, 200),
        body: digest.summary,
        businessId,
        actorName: me.name,
        url: "/?tab=ADVISORY",
      });
      await auditLog(me, "ADVISOR_DIGEST_PUBLISH", "RECORD", digest.headline, "ADVISOR_DIGEST", businessId, businessId, null, digest.summary.slice(0, 400), session.orgId ?? null);
    }
    return NextResponse.json({ success: true, digest });
  } catch (error: any) {
    return apiError(error);
  }
}
