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
 *   2. the platform's own `x-vercel-cron` invocation header;
 *   3. on Vercel with no CRON_SECRET at all, platform cron calls arrive
 *      unauthenticated — accepted because the pipeline is idempotent,
 *      marker-gated and returns no personal data (counts only);
 *   4. an authenticated OWNER / GENERAL_MANAGER / super-admin session —
 *      the manual "run it now" path (and the self-hosted path, where
 *      setting CRON_SECRET is strongly recommended).
 *
 * /api/init additionally runs the same pipeline once per day as a pull-based
 * fallback, so deployments without any scheduler still get digests,
 * escalations and stock alerts — just on the first login of the day.
 */

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = request.headers.get("authorization") || "";
    let via: string | null = null;
    if (secret && auth === `Bearer ${secret}`) via = "bearer";
    else if (request.headers.get("x-vercel-cron")) via = "vercel-cron";
    else if (!secret && process.env.VERCEL) via = "vercel-cron-unsecured";

    if (!via) {
      const session = await getSessionInfo(request);
      const role = String(session?.user?.role || "").toUpperCase();
      if (session && (role === "OWNER" || role === "GENERAL_MANAGER" || !!session.user?.isSuperAdmin)) {
        via = "session";
      } else {
        return NextResponse.json(
          { success: false, error: "Unauthorized — cron secret or an executive session required." },
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
