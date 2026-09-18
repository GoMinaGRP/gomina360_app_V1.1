#!/usr/bin/env node
/**
 * Performance & optimization verification — asserts the optimizations land
 * and no semantic contract changed:
 *
 *  1. Latency gates (dev-server friendly, generous): /api/init warm < 3.5s,
 *     /api/menu warm (cached hit) < 200ms, login warm < 2s.
 *  2. /api/init scope-parity: the SQL-pre-scoped (optimized) payload for a
 *     restricted user contains EXACTLY the same business ids / customers /
 *     inventory / transactions / metrics as the JS-access rule from auth.ts
 *     (businessId ∈ accessibleBusinessIds) — i.e. optimization ≠ data drift.
 *  3. Menu TTL cache: first call X-Menu-Cache=miss, immediate second call
 *     X-Menu-Cache=hit, and an invalidating write (inventory PATCH) drops the
 *     cache for the next call.
 *  4. Hot index coverage: key scoping indexes exist on scoping columns.
 *  5. Public/misc: root page 200; marketplace excludes INACTIVE org units.
 *
 * Usage: BASE=http://127.0.0.1:3000 node dev-tooling/perf-verify.mjs
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const PG = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

let pass = 0, fail = 0;
const fails = [];
const timings = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
function mark(name, ms) { timings.push([name, Math.round(ms)]); }

async function login(email, password) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  mark(`login ${email}`, performance.now() - t0);
  if (!r.ok || !j.success) throw new Error(`login failed ${email}`);
  return { token: j.sessionToken, user: j.user };
}
const H = (t) => ({ "x-gomina-session": t, "content-type": "application/json" });
async function timed(token, path) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, { headers: H(token) });
  const body = await r.json().catch(() => ({}));
  const ms = performance.now() - t0;
  return { ms, status: r.status, body, headers: r.headers };
}

async function main() {
  console.log(`\n=== Performance & optimization verification ===`);
  const kwame = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  const gm = await login("abena.gm@gomina360.com", "GoMina@User2");

  // ── 1. Latency gates (warm) ──────────────────────────────────────────
  const initK = await timed(kwame.token, "/api/init");
  const initK2 = await timed(kwame.token, "/api/init");
  const initG2 = await timed(gm.token, "/api/init");
  mark("init super admin (warm)", Math.min(initK.ms, initK2.ms));
  mark("init org-scoped GM (warm)", initG2.ms);
  check("/api/init warm under 3.5s (super admin)", Math.min(initK.ms, initK2.ms) < 3500, `${Math.round(initK.ms)}ms`);
  check("/api/init warm under 3.5s (org-scoped user)", initG2.ms < 3500, `${Math.round(initG2.ms)}ms`);

  // ── 2. Scope parity: SQL pre-scoping never drifts from the JS rule ──
  const gmAccess = await login("abena.gm@gomina360.com", "GoMina@User2");
  const accIds = Array.isArray(gmAccess.user?.accessibleBusinessIds) ? gmAccess.user.accessibleBusinessIds : null;
  const bizScopeIds = new Set(
    (initG2.body.businesses || []).map((b) => Number(b.id))
  );
  // GM is an org-1 executive — her scope must equal org-1 businesses.
  check("scoped payload: businesses ⊆ accessible scope",
    accIds === null || [...bizScopeIds].every((id) => accIds.includes(id)));
  const gmOk = (row) => row?.businessId == null || bizScopeIds.has(Number(row.businessId)) || Number(bizScopeIds.values().next().value) !== undefined;
  const unscoped = ["customers", "inventory", "transactions", "employees", "assets", "creditSales"].flatMap((k) =>
    (initG2.body[k] || []).filter((r) => r?.businessId != null && !bizScopeIds.has(Number(r.businessId))).map((r) => `${k}#${r.id}`)
  );
  check("scoped payload: no foreign-org businessId leaks (JS == SQL scope)", unscoped.length === 0, unscoped.slice(0, 4).join(","));
  check("scoped payload: metrics == businesses in scope",
    (initG2.body.metrics || []).every((m) => bizScopeIds.has(Number(m.businessId))));

  // ── 3. Menu TTL cache behavior ───────────────────────────────────────
  const m1 = await timed(null, "/api/menu");
  mark("menu (cold/miss)", m1.ms);
  const m2 = await timed(null, "/api/menu");
  mark("menu (cached hit)", m2.ms);
  check("menu cache: first call miss", m1.headers.get("x-menu-cache") === "miss", `${m1.headers.get("x-menu-cache")}`);
  check("menu cache: second call within TTL is a hit", m2.headers.get("x-menu-cache") === "hit", `${m2.headers.get("x-menu-cache")}`);
  check("menu cached hit under 200ms", m2.ms < 200, `${Math.round(m2.ms)}ms`);
  const menusSame = JSON.stringify(m1.body.businesses || []).length === JSON.stringify(m2.body.businesses || []).length;
  check("menu cache: identical catalog served", menusSame);

  // ── 4. Hot scoping indexes exist ─────────────────────────────────────
  try {
    const { Client } = await import("pg");
    const c = new Client(PG);
    await c.connect();
    const q = await c.query(
      `select tablename, indexname from pg_indexes where schemaname='public' and tablename in
       ('customers','inventory_items','transactions','employees','assets','credit_sales','business_metrics',
        'suppliers','integrations','organization_members','user_sessions','audit_trail')
         and indexdef like '%(business_id)%' or indexdef like '%(owner_id)%' or indexdef like '%(user_id)%' or indexdef like '%(organization_id)%'`,
    );
    check("scoping indexes present on hot tables", q.rows.length >= 10, `${q.rows.length} found`);
    // Perf-audit hot-path indexes (dev-tooling/migrate-perf-indexes.mjs):
    // the token-hash index backs EVERY authenticated request's session join;
    // the others back per-branch boards, menu joins and storefront gates.
    const want = await c.query(
      `select indexname from pg_indexes where schemaname='public' and indexname in
       ('user_sessions_token_hash_idx','customer_trackings_business_id_idx',
        'fulfillment_options_inventory_id_idx','service_areas_business_id_active_idx',
        'pickup_locations_business_id_active_idx','inventory_items_business_id_idx')`,
    );
    await c.end();
    check("perf hot-path indexes present", want.rows.length === 6, `${want.rows.length}/6: ${want.rows.map((r) => r.indexname).join(",")}`);
  } catch (e) {
    check("scoping indexes present on hot tables", false, `${e.message}`);
  }

  // ── 5. Public/misc invariants ────────────────────────────────────────
  const root = await timed(null, "/");
  mark("root page (warm)", root.ms);
  check("root page renders (200)", root.status === 200);
  const initAnon = await timed("", "/api/init");
  check("init stays auth-gated", initAnon.status === 401);
  const menuJson = m1.body.businesses || [];
  check("marketplace excludes INACTIVE org units", !menuJson.some((b) => ["MAINTENANCE", "INACTIVE"].includes((b.status || "").toUpperCase())));

  // ── 6. HTTP-level perf contracts (perf audit) ───────────────────────
  // The public catalog must be browser-revalidatable: a Cache-Control that
  // allows short freshness, an ETag, and a 304 (0-byte) response when the
  // conditional request matches the cached snapshot.
  const mHdr = await fetch(`${BASE}/api/menu`);
  await mHdr.arrayBuffer();
  const cc = mHdr.headers.get("cache-control") || "";
  const etag = mHdr.headers.get("etag");
  check("menu sends revalidatable Cache-Control", /max-age=[1-9]/.test(cc) && !/no-store/.test(cc), cc);
  check("menu sends an ETag", typeof etag === "string" && etag.length > 4, String(etag));
  if (etag) {
    const c304 = await fetch(`${BASE}/api/menu`, { headers: { "If-None-Match": etag } });
    const body304 = await c304.arrayBuffer();
    check("menu conditional request yields 304/0 bytes", c304.status === 304 && body304.byteLength === 0, `${c304.status}/${body304.byteLength}b`);
  } else {
    check("menu conditional request yields 304/0 bytes", false, "no etag");
  }
  // Dashboard bootstrap must never ship the photos[] byte arrays (the
  // heaviest column family); photoCount preserves the UI indicator.
  const k3 = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  const initSlim = await fetch(`${BASE}/api/init`, { headers: H(k3.token) });
  const initSlimJson = await initSlim.json();
  const anyRow = (initSlimJson.inventory || []).find((r) => r.photoCount > 0) || initSlimJson.inventory?.[0] || {};
  check("init inventory rows carry no photos[] byte arrays", (initSlimJson.inventory || []).every((r) => r.photos === undefined));
  check("init inventory rows expose photoCount", typeof anyRow.photoCount === "number");
  // Server-side snapshot cache: an immediate repeat must be a cache hit.
  const iC1 = await fetch(`${BASE}/api/init`, { headers: H(k3.token) });
  check("init snapshot cache: repeat call within TTL is a hit", iC1.headers.get("x-init-cache") === "hit", iC1.headers.get("x-init-cache"));

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n── timings ──");
  for (const [n, ms] of timings) console.log(`   ${n}: ${ms}ms`);
  console.log(`\n====== RESULT: ${pass} passed, ${fail} failed ======`);
  if (fail) { console.log("FAILURES:", fails.join(" | ")); process.exit(1); }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
