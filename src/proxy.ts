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
  { prefix: "/api/currency", methods: ["GET"] }, // public display-only exchange rates
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

/**
 * Does this (path, method) pair pass the advisor policy on its own?
 *
 * A pure string comparison — no session, no database. Kept separate from the
 * proxy so the cheap question can be answered FIRST (see below).
 *
 * Exported for dev-tooling/verify-proxy-fast-path.mjs, which asserts the
 * classification directly rather than inferring it from timings.
 */
export function advisorAllows(pathname: string, method: string): boolean {
  for (const rule of ADVISOR_API_ALLOWLIST) {
    if (pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) {
      return !rule.methods || rule.methods.includes(method);
    }
  }
  return false;
}

/**
 * PERF · the session lookup moved OFF the hot path.
 *
 * This used to resolve the session FIRST and only then consult the allowlist —
 * so every single /api/* call paid a database round trip to learn a role that
 * the path+method already decided. On Vercel the proxy and the route handler
 * run as SEPARATE invocations, so getSessionInfo()'s 5 s micro-cache is not
 * shared between them: the token was resolved from Postgres TWICE per
 * authenticated request. Against a REMOTE Neon database that is a second full
 * round trip on every call — invisible locally, very expensive in production.
 *
 * Reordering is PROVABLY equivalent, not a relaxation:
 *   • allowed (path, method) → the advisor passed anyway, so EVERYONE passes;
 *     the resolved role could not have changed the outcome. The lookup was
 *     pure waste → skip it.
 *   • not allowed → the advisor is refused and everyone else passes, which is
 *     the only case that genuinely needs the role, so resolve it there.
 * The 403 body, the fail-open catch and the per-route authorization backstop
 * are all unchanged; the policy decides exactly what it decided before.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = (request.method || "GET").toUpperCase();

  // Fast path — allowlisted for advisors, so no role lookup can change this.
  if (advisorAllows(pathname, method)) return NextResponse.next();

  try {
    const info = await getSessionInfo(request);
    // Only FARM_ADVISOR sessions are policy-checked; everyone else passes.
    if (!info || !isFarmAdvisor(info.user)) return NextResponse.next();

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
  matcher: ["/api/:path*"],
};
