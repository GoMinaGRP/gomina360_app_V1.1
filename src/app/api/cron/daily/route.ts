import { NextRequest, NextResponse } from "next/server";
import { getSessionInfo } from "@/lib/auth";
import { runDailyOps } from "@/lib/dailyOps";

/**
 * The scheduled heartbeat (P2): GET/POST /api/cron/daily.
 *
 * Wired in vercel.json to run daily at 06:00 UTC (= 06:00 Ghana — the
 * operating timezone of every GoMina unit). Authorization, in order:
 *   1. `Authorization: Bearer $CRON_SECRET` when the env is set (Vercel
 *      Cron sends this automatically once CRON_SECRET is configured);
 *   2. an authenticated OWNER / GENERAL_MANAGER / super-admin session —
 *      the manual "run it now" path.
 *
 * FAIL CLOSED (final production audit): earlier versions also accepted a
 * bare `x-vercel-cron` request header — and, on Vercel without CRON_SECRET,
 * ANY unauthenticated caller. Request headers are client-controlled, so that
 * was a spoofable trigger for the pipeline: an anonymous visitor could force
 * digests, escalations and stock alerts on demand. The header is no longer
 * trusted; configure CRON_SECRET and Vercel Cron authenticates itself.
 * Deployments with no scheduler are still covered — /api/init runs the same
 * pipeline once a day as a pull-based fallback (first authenticated request
 * of the day) — so nothing silently stops working.
 */

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = request.headers.get("authorization") || "";
    let via: string | null = null;
    if (secret && auth === `Bearer ${secret}`) via = "bearer";

    if (!via) {
      const session = await getSessionInfo(request);
      const role = String(session?.user?.role || "").toUpperCase();
      if (session && (role === "OWNER" || role === "GENERAL_MANAGER" || !!session.user?.isSuperAdmin)) {
        via = "session";
      } else {
        const hint =
          !secret && process.env.VERCEL
            ? " Set CRON_SECRET in Vercel → Settings → Environment Variables (Production AND Preview); Vercel Cron then sends it automatically as a Bearer token."
            : "";
        return NextResponse.json(
          { success: false, error: `Unauthorized — cron secret or an executive session required.${hint}` },
          { status: 401 },
        );
      }
    }

    const force = new URL(request.url).searchParams.get("force") === "1";
    const result = await runDailyOps({ source: via === "session" && force ? "manual" : "cron" });

    // Public-surface response: counts only — never per-user identifiers.
    return NextResponse.json({
      success: true,
      via,
      ran: result.ran,
      skipped: result.skipped ?? false,
      date: result.date,
      lowStockBusinesses: (result.lowStock || []).filter((s) => s.lowCount + s.outCount > 0).length,
      tasksAutoCompleted: result.tasksAutoCompleted ?? 0,
      tasksEscalated: result.tasksEscalated ?? 0,
      issuesEscalated: result.issuesEscalated ?? 0,
      digestsSent: (result.digests || []).filter((d) => d.sent).length,
      steps: result.steps,
    });
  } catch (e) {
    console.error("[api/cron/daily]", e);
    return NextResponse.json({ success: false, error: "Daily ops pipeline failed." }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
