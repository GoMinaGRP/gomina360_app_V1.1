import { NextResponse } from "next/server";
import { db } from "@/db";
import { readInitSnapshot, brandingVersionOf } from "@/lib/initSnapshot";
import { ttlGet, ttlSet } from "@/lib/ttlCache";
import { getSessionInfo, accessibleBusinessIds, filterByAccess } from "@/lib/auth";
import { BUSINESS_TYPES } from "@/lib/businessTypes";
import { ensureTodayFor, sweepOverdueCritical } from "@/lib/checklistGen";
import { compressJsonBody } from "@/lib/httpGzip";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/** The first request in each process runs the seed-if-empty check; after a
 *  successful pass the DB is non-empty (seed only ADDS rows) so later
 *  requests skip the extra SELECT + advisory lock entirely. A failed check
 *  leaves the flag false so the next request retries. The seed module is
 *  imported dynamically so a serverless cold start does not pay for its
 *  ~1.9k-line bundle on the common (already-seeded) path. */
let seedCheckedThisProcess = false;

/** 2.5 s per-viewer snapshot of the fully-scoped bootstrap payload. Session
 *  resolution ALWAYS runs fresh before this cache is consulted, and the key
 *  embeds user id + role + org list + accessible business ids, so viewers can
 *  never see another tenant's rows. Any mutation route that already
 *  invalidates the menu also invalidates "init"; everything else goes stale
 *  for at most 2.5 s (dashboard refreshes are user-driven and infrequent).
 *  The cached entry stores BOTH the raw JSON and its gzip form so a cache hit
 *  never re-compresses 100+ KB. */
const INIT_TTL_MS = 2_500;

interface InitCacheEntry {
  raw: string;
  gz: Buffer | null;
}

function initCacheKey(session: any, allowed: number[] | null): string {
  const me = session.user;
  const scope = JSON.stringify({
    u: me.id,
    r: me.role,
    o: me.organizationIds || [],
    b: allowed === null ? "ALL" : [...allowed].sort((a, b) => a - b),
  });
  return `init:v1:${me.id}:${createHash("sha1").update(scope).digest("base64url").slice(0, 12)}`;
}

export async function GET(request: Request) {
  try {
    // Run seed if database is empty (once per process — the check itself is a
    // DB round trip that used to run on EVERY dashboard load).
    if (!seedCheckedThisProcess) {
      const { seedDatabase } = await import("@/db/seed");
      await seedDatabase();
      seedCheckedThisProcess = true;
    }

    // ── Secure login gate ───────────────────────────────────────────────
    // Every byte of data returned below is scoped to the signed-in user.
    const session = await getSessionInfo(request);
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Sign in required." },
        { status: 401 }
      );
    }
    const me = session.user;
    const allowed = await accessibleBusinessIds(me, session.orgIds); // null ⇒ Super Admin (all)
    const cacheKey = initCacheKey(session, allowed);
    const cached = ttlGet<InitCacheEntry>(cacheKey);
    if (cached !== undefined) {
      const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") || "");
      if (cached.gz && acceptsGzip) {
        return new Response(new Uint8Array(cached.gz), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Content-Encoding": "gzip",
            "Content-Length": String(cached.gz.length),
            Vary: "Accept-Encoding",
            "X-Init-Cache": "hit",
          },
        });
      }
      return new Response(cached.raw, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Init-Cache": "hit", Vary: "Accept-Encoding" },
      });
    }

    const isExecutive = me.role === "OWNER" || me.role === "GENERAL_MANAGER";
    const myOrgs: number[] = me.isSuperAdmin ? [] : (me.organizationIds || (session.orgId ? [session.orgId] : []));
    // Rows whose tenant is carried in .ownerId (shared/global tables):
    // Super Admin ⇒ all; everyone else ⇒ only their own organization(s).
    const inMyOrg = (ownerId: any) => me.isSuperAdmin || myOrgs.includes(Number(ownerId));
    const bids: number[] | null = allowed === null ? null : allowed.length ? allowed : [-1];
    const orgScope: number[] | null = me.isSuperAdmin ? null : myOrgs.length ? myOrgs : [-1];

    // Daily-checklist convergence (M6): every scoped business ALWAYS has its
    // daily checklist for today before the payload below is assembled, so the
    // Command Center compliance panel and every module reflect the live plan
    // instead of an empty day. Idempotent; ONE round trip in steady state
    // (business list + distinct-today check together), real inserts only on
    // the first init of the day per business.
    if (!bids || bids[0] !== -1) {
      const todayLocal = new Date().toLocaleDateString("en-CA");
      try {
        await ensureTodayFor(bids, todayLocal); // null ⇒ Super Admin ⇒ all businesses
      } catch (e) {
        console.error("[checklistGen] ensureTodayFor failed (continuing without generation):", (e as any)?.message || e);
      }
      // Overdue-critical sweep: incomplete CRITICAL tasks for today past the
      // cutoff hour (default 18:00, per-business configurable) notify the
      // managers + assignees — once per business+date (recordRef-deduped).
      // Fire-and-forget: never blocks the init payload.
      sweepOverdueCritical(bids).catch((e) => {
        console.error("[checklistGen] overdue sweep failed (continuing):", (e as any)?.message || e);
      });
    }

    // ── Data fetch: ONE multi-statement round trip ───────────────────────
    // 24 parallel selects + 4 sequential follow-ups used to fan out over the
    // pool (with PG_POOL_MAX=2 on serverless that is 12+ latency waves on a
    // remote database). readInitSnapshot concatenates every read into a
    // single simple-protocol batch: one connection, one round trip, same rows
    // and identical scoping. The JavaScript filtering below remains the final
    // enforcement layer — semantics are identical to the previous access path.
    const orgIdForSettings = me.isSuperAdmin ? (session.orgId ?? 1) : (session.orgId ?? myOrgs[0] ?? null);
    const snap = await readInitSnapshot({
      bids,
      orgScope,
      selfUserId: Number(me.id) || 0,
      execMemberOrgs: isExecutive && !me.isSuperAdmin ? (myOrgs.length ? myOrgs : [-1]) : null,
      orgIdForSettings,
      isSuperAdmin: !!me.isSuperAdmin,
    });

    // ── Scope everything to the user's accessible businesses ────────────
    const scopedBusinesses =
      allowed === null
        ? snap.businesses
        : snap.businesses.filter((b) => allowed.includes(b.id));
    // Login users visible to this user: executives get the full directory;
    // managers/workers see only accounts sharing their accessible businesses.
    // Sensitive auth fields are NEVER exposed.
    const stripSecret = (u: any) => {
      const { passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe } = u;
      return safe;
    };
    // User directory: Super Admin ⇒ everyone; org executives ⇒ members of
    // their OWN organization(s) only; others ⇒ same-business accounts.
    // (The snapshot's SQL already pre-narrows to exactly these sets.)
    let execMemberIds: Set<number> | null = null;
    if (isExecutive && !me.isSuperAdmin) {
      execMemberIds = new Set(snap.execMemberIds);
    }
    const scopedUsers = (isExecutive
      ? (me.isSuperAdmin ? snap.users : snap.users.filter((u) => u.id === me.id || execMemberIds!.has(u.id)))
      : snap.users.filter(
          (u) =>
            u.id === me.id ||
            (u.assignedBusinessId != null && allowed!.includes(Number(u.assignedBusinessId)))
        )
    ).map(stripSecret);

    // Scenario simulations: business-targeted ones follow business scope;
    // un-targeted ("all businesses") ones belong to the owner's organization.
    const scopedScenarios =
      allowed === null
        ? snap.scenarios
        : snap.scenarios.filter(
            (s: any) =>
              (s.targetBusinessId != null && allowed.includes(Number(s.targetBusinessId))) ||
              (s.targetBusinessId == null && inMyOrg(s.ownerId))
          );

    // Credit sales (branch-isolated) + per-customer credit position, so the
    // CRM shows who owes what without another round-trip.
    const scopedCreditSales = filterByAccess(snap.creditSales, allowed);
    const creditByCustomer = new Map<number, { count: number; total: number; outstanding: number }>();
    for (const cs of scopedCreditSales) {
      if (cs.customerId == null) continue;
      const agg = creditByCustomer.get(cs.customerId) || { count: 0, total: 0, outstanding: 0 };
      agg.count += 1;
      agg.total += Number(cs.totalGhs) || 0;
      agg.outstanding += Number(cs.balanceGhs) || 0;
      creditByCustomer.set(cs.customerId, agg);
    }
    const withCredit = (c: any) => {
      const agg = creditByCustomer.get(c.id);
      return {
        ...c,
        creditSalesCount: agg?.count || 0,
        creditTotalGhs: Math.round((agg?.total || 0) * 100) / 100,
        creditOutstandingGhs: Math.round((agg?.outstanding || 0) * 100) / 100,
      };
    };

    // Allowed Business Types of the caller's organization (drives both the UI
    // category pickers and the server-side creation gate). Super Admin ⇒ all.
    // Folded into the snapshot read — no extra round trip.
    const restricted = orgIdForSettings != null ? snap.bizTypesRestricted === true : false;
    const typeKeys = restricted ? snap.bizTypeKeys : BUSINESS_TYPES.map((t) => t.key);
    const allowedBizTypes = {
      restricted,
      labelsAndKeys: typeKeys.map((k) => ({
        key: k,
        label: BUSINESS_TYPES.find((t) => t.key === k)?.label ?? k,
      })),
    };

    const payload = {
      success: true,
      accessibleBusinessIds: allowed,
      isSuperAdmin: !!me.isSuperAdmin,
      organization: snap.myOrgRow
        ? { id: snap.myOrgRow.id, name: snap.myOrgRow.name, slug: snap.myOrgRow.slug, status: snap.myOrgRow.status }
        : null,
      organizations: snap.orgDirectory.map((o: any) => ({ id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.created_at ?? o.createdAt })),
      allowedBusinessTypes: {
        restricted: allowedBizTypes.restricted,
        types: allowedBizTypes.labelsAndKeys,
      },
      businesses: scopedBusinesses,
      // Logos moved off the hot path: the payload carries a content-hashed
      // brandingVersion; /api/branding serves the actual images with ETag +
      // browser caching (and the client keeps a localStorage copy), so a
      // 50-100 KB base64 crest is no longer re-downloaded on EVERY dashboard
      // bootstrap and after EVERY save.
      brandingVersion: brandingVersionOf(snap),
      companyLogo: null,
      metrics: filterByAccess(snap.metrics, allowed),
      users: scopedUsers,
      customers: (allowed === null
        ? snap.customers
        : snap.customers.filter(
            (c: any) => (c.businessId == null ? inMyOrg(c.ownerId) : allowed.includes(Number(c.businessId)))
          )
      ).map(withCredit),
      creditSales: scopedCreditSales,
      suppliers: snap.suppliers.filter((s: any) => inMyOrg(s.ownerId)), // per-organization supplier directory
      employees: filterByAccess(snap.employees, allowed),
      assets: filterByAccess(snap.assets, allowed),
      // Slim transport: the `photos[]` arrays (N× base64 data URLs per row —
      // the single heaviest column family in this payload) never leave the
      // server on dashboard bootstrap. `photo` (the one thumbnail the UI
      // actually renders) stays, and `photoCount` preserves the "N photos"
      // indicator. Full photos still ship in the dedicated detail endpoints.
      inventory: filterByAccess(snap.inventory, allowed).map((item: any) => {
        const { photos, ...rest } = item;
        return { ...rest, photoCount: Array.isArray(photos) ? photos.length : 0 };
      }),
      transactions: filterByAccess(snap.transactions, allowed),
      aiInsights: (allowed === null
        ? snap.aiInsights
        : snap.aiInsights.filter(
            (i: any) => (i.businessId == null ? inMyOrg(i.ownerId) : allowed.includes(Number(i.businessId)))
          )
      ),
      scenarios: scopedScenarios,
      integrations: snap.integrations.filter((i: any) => inMyOrg(i.ownerId)),
      checklists: {
        templates: filterByAccess(snap.checklistTemplates, allowed),
        entries: filterByAccess(snap.checklistEntries, allowed),
      },
      specializedLogs: {
        poultry: filterByAccess(snap.specializedLogs.poultry, allowed),
        blockFactory: filterByAccess(snap.specializedLogs.blockFactory, allowed),
        aquaculture: filterByAccess(snap.specializedLogs.aquaculture, allowed),
        livestock: filterByAccess(snap.specializedLogs.livestock, allowed),
        restaurant: filterByAccess(snap.specializedLogs.restaurant, allowed),
        electronics: filterByAccess(snap.specializedLogs.electronics, allowed),
        carWash: filterByAccess(snap.specializedLogs.carWash, allowed),
        hardware: filterByAccess(snap.specializedLogs.hardware, allowed),
      },
    };
    const raw = JSON.stringify(payload);
    const gz =
      /\bgzip\b/i.test(request.headers.get("accept-encoding") || "") && raw.length >= 1024
        ? gzipSync(Buffer.from(raw, "utf8"))
        : null;
    ttlSet(cacheKey, { raw, gz }, INIT_TTL_MS);
    if (gz) {
      return new Response(new Uint8Array(gz), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Encoding": "gzip",
          "Content-Length": String(gz.length),
          Vary: "Accept-Encoding",
          "X-Init-Cache": "miss",
        },
      });
    }
    return new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Init-Cache": "miss", Vary: "Accept-Encoding" },
    });
  } catch (error: any) {
    console.error("Error in /api/init:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to initialize database" },
      { status: 500 }
    );
  }
}
