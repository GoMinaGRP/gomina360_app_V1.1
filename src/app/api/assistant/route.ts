import { NextRequest, NextResponse } from "next/server";
import { getSessionInfo, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { buildAssistantFeed, answerQuestion } from "@/lib/biAssistant";
import { roleGroupMembers } from "@/lib/roles";

/**
 * /api/assistant — R5 Unified BI Assistant.
 *
 * GET  ?q=<question>   → deterministic, grounded answer (U2)
 * GET  (no q)          → the unified cross-module feed (U1)
 * POST { question }    → same as GET ?q=
 *
 * Executives only: OWNER, GENERAL_MANAGER, BRANCH_MANAGER (or super admin).
 * Every number is computed inside the caller's accessible-business scope.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const role = String(me.role || "").toUpperCase();
    const allowedRoles = roleGroupMembers("UNIT_ADMIN");
    if (!allowedRoles.includes(role) && !me.isSuperAdmin) {
      return FORBIDDEN("The BI Assistant is available to the Owner, General Manager and Branch Managers.");
    }
    const allowed = await accessibleBusinessIds(me);
    const url = new URL(request.url);
    const question = (url.searchParams.get("q") || "").trim().slice(0, 400);

    if (question) {
      const answer = await answerQuestion(question, { businessIds: allowed });
      return NextResponse.json({ success: true, ...answer, scope: allowed === null ? "ALL" : allowed }, { headers: { "Cache-Control": "no-store" } });
    }

    const feed = await buildAssistantFeed({ businessIds: allowed });
    return NextResponse.json(
      { success: true, feed, scope: allowed === null ? "ALL" : allowed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const role = String(me.role || "").toUpperCase();
    const allowedRoles = roleGroupMembers("UNIT_ADMIN");
    if (!allowedRoles.includes(role) && !me.isSuperAdmin) {
      return FORBIDDEN("The BI Assistant is available to the Owner, General Manager and Branch Managers.");
    }
    const allowed = await accessibleBusinessIds(me);
    const body = await request.json();
    const question = String(body?.question || "").trim().slice(0, 400);
    if (!question) return NextResponse.json({ success: false, error: "Ask a question first." }, { status: 400 });
    const answer = await answerQuestion(question, { businessIds: allowed });
    return NextResponse.json({ success: true, ...answer, scope: allowed === null ? "ALL" : allowed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    return apiError(error);
  }
}
