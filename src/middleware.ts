import { NextRequest, NextResponse } from "next/server";
import { getSessionInfo, isFarmAdvisor } from "@/lib/auth";

/**
 * Farm Advisor API policy — the single server-side choke point for the
 * external FARM_ADVISOR role.
 *
 * Business access today equals data access: /api/init, /api/transactions,
 * /api/employees, /api/users… authorize on canAccessBusiness alone. For an
 * invited advisor that would silently expose finance, HR and the user
 * directory in API payloads even with every tab hidden. This middleware
 * therefore enforces a DEFAULT-DENY policy for authenticated FARM_ADVISOR
 * sessions: only the read-only farm-operations surfaces (+ their ONE write
 * surface, /api/advisor-notes, and the session plumbing every signed-in user
 * needs) pass through. Everything else — finance, payroll, employees, the
 * user directory, exports, backups, storefront management, and every
 * mutation on farm records — is a 403 BEFORE any route code runs.
 *
 * Everyone else (OWNER / GM / BM / WORKER / anonymous) is passed through
 * untouched — their authorization stays exactly where it always was, in the
 * route handlers. If the session lookup itself fails, the request also
 * passes through (fail-open for non-advisors only): the routes' own auth
 * remains the backstop, and a middleware hiccup can never take the app down.
 *
 * Node.js runtime (stable since Next 15.5) so the shared pg-backed session
 * resolver can be reused verbatim — its 5 s micro-cache keeps the added
 * round trip off the hot path.
 */

interface AdvisorApiRule {
  /** Path prefix this rule covers ("/api/poultry" also matches "/api/poultry/xyz"). */
  prefix: string;
  /** Allowed methods; null = every method (the advisor's own surfaces). */
  methods: string[] | null;
}

const ADVISOR_API_ALLOWLIST: AdvisorApiRule[] = [
  // ── Session plumbing every signed-in user needs ──────────────────────
  { prefix: "/api/auth", methods: null }, // login / logout / me / change-password
  { prefix: "/api/session", methods: null }, // idle heartbeat (park/un-park)
  { prefix: "/api/health", methods: ["GET"] },
  { prefix: "/api/profile", methods: null }, // own profile
  { prefix: "/api/branding", methods: ["GET"] },
  { prefix: "/api/menu", methods: ["GET"] }, // public storefront catalogue
  { prefix: "/api/geocode", methods: ["GET"] },
  { prefix: "/api/reverse-geocode", methods: ["GET"] },
  // ── Read-only farm operations & performance ───────────────────────────
  { prefix: "/api/init", methods: ["GET"] }, // advisor-slimmed payload (see init route)
  { prefix: "/api/poultry", methods: ["GET"] },
  { prefix: "/api/aquaculture", methods: ["GET"] },
  { prefix: "/api/livestock", methods: ["GET"] },
  { prefix: "/api/checklists", methods: ["GET"] }, // view plan + completion status only
  { prefix: "/api/daily-notes", methods: ["GET"] }, // staff notes + AI daily summary
  { prefix: "/api/logs", methods: ["GET"] }, // operations logs of granted units
  { prefix: "/api/businesses", methods: ["GET"] }, // scoped to granted units
  // ── The advisor's own surfaces ────────────────────────────────────────
  { prefix: "/api/advisor-notes", methods: null }, // the ONE write surface
  { prefix: "/api/advisor", methods: ["GET"] }, // own assignments (grants)
  // ── Their bell & push (existing machinery) ────────────────────────────
  { prefix: "/api/notifications", methods: ["GET", "PATCH"] },
  { prefix: "/api/push", methods: null }, // own push subscriptions
];

export async function middleware(request: NextRequest) {
  try {
    const info = await getSessionInfo(request);
    // Only FARM_ADVISOR sessions are policy-checked; everyone else passes.
    if (!info || !isFarmAdvisor(info.user)) return NextResponse.next();

    const { pathname } = request.nextUrl;
    const method = (request.method || "GET").toUpperCase();
    for (const rule of ADVISOR_API_ALLOWLIST) {
      if (pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) {
        if (!rule.methods || rule.methods.includes(method)) return NextResponse.next();
        break; // right path, wrong verb → read-only violation → 403 below
      }
    }
    return NextResponse.json(
      {
        success: false,
        error: "Farm Advisor accounts have read-only access to farm operations. Recording, finance, HR and management functions are not available to this role.",
      },
      { status: 403 },
    );
  } catch {
    // Never let the policy layer break the app: pass through to the routes'
    // own authorization (which remains the backstop for every role).
    return NextResponse.next();
  }
}

export const config = {
  runtime: "nodejs",
  matcher: ["/api/:path*"],
};
