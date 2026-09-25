/**
 * verify-farm-advisor.mjs — end-to-end verification of the External Farm
 * Advisor / Resource Person feature (API layer + security model).
 *
 *   A · Owner can mint an ADVISOR account and grant scoped access.
 *   B · Advisor sign-in, /api/init data minimisation (no finance, HR, CRM,
 *       no money fields, only their own user row).
 *   C · Scoped reads: only granted businesses; other farms → 403.
 *   D · Read-only enforcement: every write path outside the advisory
 *       allowlist is refused (403), on granted AND ungranted businesses.
 *   E · Advisory notes: create, AI analysis, audit issue linkage, owner
 *       acknowledge → start → done, replies both ways, notifications.
 *   F · Visits + AI Advisory Digest (benchmarks, concerns, recommendations,
 *       adoption) and digest publication into aiInsights.
 *   G · Cost visibility toggle (secure default = hidden).
 *   H · Revocation kills the session; expiry (endsOn in the past) blocks
 *       access; restoring re-enables it.
 *   I · Existing roles unaffected (owner / GM / BM / worker smoke checks).
 *   J · Audit trail rows written for grant, note and digest actions.
 *
 * Test rows are cleaned up at the end. Run with the app on :3000:
 *   node dev-tooling/verify-farm-advisor.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const STAMP = Date.now();
const ADVISOR_EMAIL = `vet.advisor.${STAMP}@example.com`;

const CREDS = {
  owner: { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" },
  gm: { email: "abena.gm@gomina360.com", password: "GoMina@User2" },
  bm1: { email: "emmanuel@gomina360.com", password: "GoMina@User3" },
  worker1: { email: "akua.donkor@gomina360.com", password: "GoMina@User10" },
};

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name} — ${detail}`); }
  return !!cond;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const login = async (c) => (await call("/api/auth/login", "POST", c)).json?.sessionToken || null;

const db = new Client({ connectionString: DB });
await db.connect();

let advisorId = null, grantId = null, noteId = null, visitId = null;

try {
  /* ── A · Owner mints an advisor and grants scoped access ─────────────── */
  section("A · Grant lifecycle (Owner controlled)");
  const t = {};
  for (const [k, c] of Object.entries(CREDS)) {
    t[k] = await login(c);
    ok(`login ${k}`, !!t[k]);
  }

  const init = await call("/api/init", "GET", null, t.owner);
  const poultryBiz = (init.json?.businesses || []).find((b) => String(b.code).startsWith("POULTRY"));
  const otherBiz = (init.json?.businesses || []).find((b) => b.id !== poultryBiz?.id);
  ok("owner init lists a poultry farm", !!poultryBiz);
  ok("owner init lists a second business (isolation target)", !!otherBiz);

  const created = await call("/api/users", "POST", {
    name: `Dr. Advisor ${STAMP}`, email: ADVISOR_EMAIL, role: "ADVISOR", phone: "+233 24 111 2222",
  }, t.owner);
  advisorId = created.json?.user?.id;
  const advisorPassword = created.json?.initialPassword;
  ok("owner creates an ADVISOR account", created.status === 200 && !!advisorId, JSON.stringify(created.json));
  ok("advisor account carries no operational powers", !!created.json?.user &&
    Object.entries(created.json.user).filter(([k, v]) => /^can[A-Z]/.test(k) && v === true).length === 0,
    JSON.stringify(created.json?.user));

  const deniedGrant = await call("/api/advisor", "POST", { userId: advisorId, businessId: poultryBiz.id }, t.worker1);
  ok("worker cannot grant advisor access → 403", deniedGrant.status === 403, `${deniedGrant.status}`);

  const grant = await call("/api/advisor", "POST", {
    userId: advisorId, businessId: poultryBiz.id,
    scopes: ["DASHBOARD", "FLOCKS", "DAILY_OPS", "DAILY_NOTES", "FEED_WATER", "GROWTH_FCR", "MORTALITY_HEALTH", "PRODUCTION", "BENCHMARK", "ALERTS"],
  }, t.owner);
  grantId = grant.json?.grant?.id;
  ok("owner grants scoped advisory access", grant.status === 200 && !!grantId, JSON.stringify(grant.json));
  ok("cost visibility defaults to HIDDEN", grant.json?.grant?.showCosts === false);
  ok("export defaults to OFF", grant.json?.grant?.canExport === false);
  ok("PHOTOS_CCTV is not granted by default", !(grant.json?.grant?.scopes || []).includes("PHOTOS_CCTV"));

  /* ── B · Advisor session + data minimisation ─────────────────────────── */
  section("B · Advisor session & /api/init minimisation");
  let advisorToken = await login({ email: ADVISOR_EMAIL, password: advisorPassword });
  ok("advisor can sign in", !!advisorToken);

  const ai = await call("/api/init", "GET", null, advisorToken);
  const p = ai.json || {};
  ok("advisor init → 200", ai.status === 200, `${ai.status}`);
  ok("advisor sees only granted businesses", (p.businesses || []).every((b) => b.id === poultryBiz.id) && (p.businesses || []).length === 1,
    JSON.stringify((p.businesses || []).map((b) => b.code)));
  for (const key of ["customers", "creditSales", "suppliers", "employees", "transactions", "assets", "scenarios", "integrations", "aiInsights", "organizations"]) {
    ok(`advisor init omits ${key}`, !Array.isArray(p[key]) || p[key].length === 0, JSON.stringify(p[key]?.length));
  }
  ok("advisor init exposes only their own user row", (p.users || []).length <= 1 && (p.users || []).every((u) => Number(u.id) === Number(advisorId)));
  ok("advisor init carries the advisor descriptor", !!p.advisor?.isAdvisor && Array.isArray(p.advisor?.grants));
  ok("advisor init hides money fields", !/"(revenueGhs|profitGhs|costGhs|totalGhs|amountGhs|salaryGhs)"\s*:\s*[0-9]/.test(JSON.stringify(p)));
  ok("advisor init leaks no secrets", !/passwordHash|password_hash|\$2b\$/.test(JSON.stringify(p)));

  /* ── C · Scoped reads ────────────────────────────────────────────────── */
  section("C · Scoped reads");
  const advData = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("advisor reads granted farm data", advData.status === 200, `${advData.status}`);
  ok("granted farm data includes flocks", Array.isArray(advData.json?.flocks));
  ok("granted farm data includes an AI digest", !!advData.json?.digest?.headline);
  ok("digest carries benchmark metrics", (advData.json?.digest?.metrics || []).length >= 4);
  ok("advisor data hides costs by default", advData.json?.showCosts === false);

  const crossData = await call(`/api/advisor/data?businessId=${otherBiz.id}`, "GET", null, advisorToken);
  ok("advisor blocked from an ungranted business → 403", crossData.status === 403, `${crossData.status}`);

  const poultryRead = await call(`/api/poultry?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("advisor reads /api/poultry for the granted farm", poultryRead.status === 200, `${poultryRead.status}`);
  ok("/api/poultry response is money-free for the advisor",
    !/"(costGhs|priceGhs|revenueGhs|totalGhs)"\s*:\s*[0-9]/.test(JSON.stringify(poultryRead.json || {})));
  const crossPoultry = await call(`/api/poultry?businessId=${otherBiz.id}`, "GET", null, advisorToken);
  ok("advisor blocked from ungranted /api/poultry → 403", crossPoultry.status === 403, `${crossPoultry.status}`);

  const forbiddenReads = [
    `/api/enterprise?businessId=${poultryBiz.id}`,
    "/api/transactions",
    `/api/employees?businessId=${poultryBiz.id}`,
    "/api/credit-sales",
    `/api/payroll?businessId=${poultryBiz.id}`,
    "/api/users",
    "/api/customers",
    "/api/sales",
    "/api/inventory",
    `/api/assets?businessId=${poultryBiz.id}`,
    "/api/audit",
    "/api/cctv",
    "/api/exports",
    "/api/procurement",
    "/api/businesses",
    "/api/admin",
    "/api/integrations",
    "/api/scenarios",
    `/api/daily-notes?businessId=${poultryBiz.id}`,
    `/api/logs/${poultryBiz.code}`,
  ];
  for (const path of forbiddenReads) {
    const r = await call(path, "GET", null, advisorToken);
    ok(`advisor GET ${path} refused`, [403, 404, 405].includes(r.status),
      `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }

  const flockId = advData.json?.flocks?.[0]?.id ?? null;

  /* ── D · Read-only enforcement ───────────────────────────────────────── */
  section("D · Read-only enforcement (writes must fail)");
  const writes = [
    ["POST", "/api/poultry", { entity: "mortality", data: { businessId: poultryBiz.id, flockId, count: 5, date: new Date().toISOString().slice(0, 10) } }],
    ["POST", "/api/poultry", { entity: "flock", data: { businessId: poultryBiz.id, batchCode: `X${STAMP}`, birdType: "BROILER", initialCount: 100 } }],
    ["PATCH", "/api/poultry", { entity: "flock", id: 1, data: { currentCount: 1 } }],
    ["DELETE", "/api/poultry?entity=flock&id=1", null],
    ["POST", "/api/transactions", { businessId: poultryBiz.id, type: "EXPENSE", category: "FEED", amountGhs: 10, description: "x", date: new Date().toISOString().slice(0, 10) }],
    ["POST", "/api/inventory", { businessId: poultryBiz.id, itemName: "x", quantity: 1, unit: "kg", unitCostGhs: 1 }],
    ["POST", "/api/users", { name: "x", email: `x${STAMP}@y.z`, role: "WORKER" }],
    ["PATCH", "/api/users", { userId: advisorId, role: "OWNER" }],
    ["POST", "/api/advisor", { userId: advisorId, businessId: otherBiz.id }],
    ["PATCH", "/api/advisor", { id: grantId, showCosts: true }],
    ["POST", "/api/credit-sales", { businessId: poultryBiz.id, customerName: "x", amountGhs: 5 }],
    ["POST", "/api/audit", { businessId: poultryBiz.id, action: "FLAG" }],
    ["POST", "/api/checklists", { businessId: poultryBiz.id }],
    ["POST", "/api/daily-notes", { businessId: poultryBiz.id, note: "x" }],
    ["POST", "/api/cctv", { businessId: poultryBiz.id, name: "x" }],
    ["POST", "/api/exports", { businessId: poultryBiz.id }],
  ];
  for (const [method, path, body] of writes) {
    const r = await call(path, method, body, advisorToken);
    ok(`advisor ${method} ${path} → refused`, [401, 403, 404, 405].includes(r.status), `${r.status} ${JSON.stringify(r.json)}`);
  }
  const selfServe = await call("/api/notifications", "GET", null, advisorToken);
  ok("advisor can still read their own notifications", selfServe.status === 200, `${selfServe.status}`);

  /* ── E · Advisory notes workflow ─────────────────────────────────────── */
  section("E · Advisory notes, AI analysis & accountability");

  const note = await call("/api/advisor/notes", "POST", {
    businessId: poultryBiz.id,
    flockId,
    type: "RECOMMENDATION",
    priority: "HIGH",
    title: `Ventilation and water sanitation ${STAMP}`,
    body: "Observed panting birds and wet litter in house 2 during the morning visit. Mortality is creeping up. Recommend raising the ridge vents, flushing the water lines with a sanitiser and re-checking the feed particle size within 48 hours.",
    requiresAction: true,
    dueDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
  }, advisorToken);
  noteId = note.json?.note?.id;
  ok("advisor files a recommendation", note.status === 200 && !!noteId, JSON.stringify(note.json));
  ok("note was analysed by the AI layer", !!note.json?.note?.aiSummary || !!note.json?.note?.aiSeverity, JSON.stringify(note.json?.note?.aiSeverity));
  ok("requiresAction created a linked audit issue", !!note.json?.note?.linkedIssueId);

  const futureNote = await call("/api/advisor/notes", "POST", {
    businessId: poultryBiz.id, type: "OBSERVATION", title: "future", body: "x".repeat(30),
    observationDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
  }, advisorToken);
  ok("future-dated observation refused", futureNote.status === 400, `${futureNote.status}`);

  const crossNote = await call("/api/advisor/notes", "POST", {
    businessId: otherBiz.id, type: "OBSERVATION", title: "cross", body: "x".repeat(30),
  }, advisorToken);
  ok("advisor cannot file a note on an ungranted farm → 403", crossNote.status === 403, `${crossNote.status}`);

  const ownerNotes = await call(`/api/advisor/notes?businessId=${poultryBiz.id}`, "GET", null, t.owner);
  ok("owner sees the advisory note", (ownerNotes.json?.notes || []).some((n) => n.id === noteId));

  const ack = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "ACKNOWLEDGE", message: "Seen, thank you." }, t.owner);
  ok("owner acknowledges the note", ack.status === 200 && ack.json?.note?.status === "ACKNOWLEDGED", JSON.stringify(ack.json));
  const start = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "START" }, t.owner);
  ok("owner starts the corrective action", start.json?.note?.status === "IN_PROGRESS", JSON.stringify(start.json?.note?.status));
  const done = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "DONE", message: "Vents raised, lines flushed." }, t.owner);
  ok("owner marks the action done", done.json?.note?.status === "DONE", JSON.stringify(done.json?.note?.status));

  const advisorReply = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "REPLY", body: "Great — I will re-check the litter on the next visit." }, advisorToken);
  ok("advisor can reply on their own note", advisorReply.status === 200, JSON.stringify(advisorReply.json));
  const advisorCannotClose = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "CLOSE" }, advisorToken);
  ok("advisor cannot close a note (owner action) → refused", advisorCannotClose.status >= 400, `${advisorCannotClose.status}`);
  const close = await call("/api/advisor/notes", "PATCH", { id: noteId, action: "CLOSE", message: "Verified on site." }, t.owner);
  ok("owner closes the loop", close.json?.note?.status === "CLOSED", JSON.stringify(close.json?.note?.status));

  const issueRow = await db.query("select status, origin from audit_reviews where id = $1", [note.json?.note?.linkedIssueId]);
  ok("linked audit issue is tagged ADVISORY", issueRow.rows[0]?.origin === "ADVISORY", JSON.stringify(issueRow.rows[0]));
  ok("linked audit issue reached a terminal state", ["RESOLVED", "VERIFIED"].includes(issueRow.rows[0]?.status), JSON.stringify(issueRow.rows[0]));

  const notif = await db.query(
    "select count(*)::int as n from notifications where type like 'ADVISOR%' and business_id = $1", [poultryBiz.id]);
  ok("advisory notifications were emitted", notif.rows[0].n > 0, JSON.stringify(notif.rows[0]));

  /* ── F · Visits & digest ─────────────────────────────────────────────── */
  section("F · Visits & AI Advisory Digest");
  const visit = await call("/api/advisor/visits", "POST", {
    businessId: poultryBiz.id, visitType: "ON_SITE", status: "COMPLETED",
    visitDate: new Date().toISOString().slice(0, 10),
    summary: "Walked all four houses, reviewed water intake and mortality curve with the supervisor.",
  }, advisorToken);
  visitId = visit.json?.visit?.id;
  ok("advisor logs a completed visit", visit.status === 200 && !!visitId, JSON.stringify(visit.json));
  ok("completed visit auto-attaches an AI digest", !!visit.json?.visit?.aiDigest);

  const digest = await call(`/api/advisor/digest?businessId=${poultryBiz.id}&windowDays=30`, "GET", null, advisorToken);
  ok("advisor can compute a digest", digest.status === 200 && !!digest.json?.digest?.headline, `${digest.status}`);
  ok("digest reports adoption of recommendations", digest.json?.digest?.adoption != null);
  const published = await call("/api/advisor/digest", "POST", { businessId: poultryBiz.id, windowDays: 30 }, advisorToken);
  ok("advisor can publish the digest to the owner", published.status === 200, JSON.stringify(published.json));
  const insight = await db.query("select count(*)::int as n from ai_insights where title like 'Advisory Digest%' and business_id = $1", [poultryBiz.id]);
  ok("digest lands in the owner's AI insights", insight.rows[0].n > 0);
  const cooldown = await call("/api/advisor/digest", "POST", { businessId: poultryBiz.id }, advisorToken);
  ok("digest publication is rate limited", cooldown.status === 429, `${cooldown.status}`);

  /* ── G · Cost visibility toggle ──────────────────────────────────────── */
  section("G · Owner-controlled cost visibility");
  await call("/api/advisor", "PATCH", { id: grantId, showCosts: true }, t.owner);
  const withCosts = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("owner can switch cost visibility on", withCosts.json?.showCosts === true, JSON.stringify(withCosts.json?.showCosts));
  await call("/api/advisor", "PATCH", { id: grantId, showCosts: false }, t.owner);
  const noCosts = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("owner can switch cost visibility back off", noCosts.json?.showCosts === false);

  /* ── H · Expiry & revocation ─────────────────────────────────────────── */
  section("H · Expiry & revocation");
  const past = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await call("/api/advisor", "PATCH", { id: grantId, endsOn: past }, t.owner);
  const expired = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("expired engagement blocks farm data → 403", expired.status === 403 || expired.status === 401, `${expired.status}`);
  const expiredNote = await call("/api/advisor/notes", "POST", {
    businessId: poultryBiz.id, type: "OBSERVATION", title: "after expiry", body: "x".repeat(40),
  }, advisorToken);
  ok("expired engagement blocks note writing", expiredNote.status >= 400, `${expiredNote.status}`);

  await call("/api/advisor", "PATCH", { id: grantId, endsOn: null }, t.owner);
  const restored = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("clearing the end date restores access", restored.status === 200, `${restored.status}`);

  const revoked = await call("/api/advisor", "PATCH", { id: grantId, isActive: false }, t.owner);
  ok("owner revokes the grant", revoked.status === 200);
  const afterRevoke = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("revocation ends the advisor session / access", afterRevoke.status === 401 || afterRevoke.status === 403, `${afterRevoke.status}`);
  advisorToken = await login({ email: ADVISOR_EMAIL, password: advisorPassword });
  const afterRelogin = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("re-login after revocation still has no farm access", afterRelogin.status === 403, `${afterRelogin.status}`);
  const initAfter = await call("/api/init", "GET", null, advisorToken);
  ok("revoked advisor sees no businesses at all", (initAfter.json?.businesses || []).length === 0,
    JSON.stringify((initAfter.json?.businesses || []).length));

  await call("/api/advisor", "PATCH", { id: grantId, isActive: true }, t.owner);
  advisorToken = await login({ email: ADVISOR_EMAIL, password: advisorPassword });
  const reinstated = await call(`/api/advisor/data?businessId=${poultryBiz.id}`, "GET", null, advisorToken);
  ok("owner can reinstate the advisor", reinstated.status === 200, `${reinstated.status}`);

  /* ── I · Existing roles unaffected ───────────────────────────────────── */
  section("I · Existing roles unaffected");
  for (const role of ["owner", "gm", "bm1", "worker1"]) {
    const r = await call("/api/init", "GET", null, t[role]);
    ok(`${role} /api/init still 200`, r.status === 200, `${r.status}`);
  }
  const ownerWrite = await call("/api/advisor/notes", "POST", {
    businessId: poultryBiz.id, type: "OBSERVATION", title: `Owner reply note ${STAMP}`,
    body: "Owner-side note confirming the corrective action was completed and verified on site today.",
  }, t.owner);
  ok("owner can also post in the advisory thread", ownerWrite.status === 200, JSON.stringify(ownerWrite.json));
  const bmPoultry = await call(`/api/poultry?businessId=${poultryBiz.id}`, "GET", null, t.bm1);
  ok("branch manager poultry read unchanged", bmPoultry.status === 200, `${bmPoultry.status}`);
  const advisorList = await call("/api/advisor", "GET", null, t.bm1);
  ok("non-delegated manager sees no management powers", advisorList.json?.meta?.canManage === false, JSON.stringify(advisorList.json?.meta));

  /* ── J · Audit trail ─────────────────────────────────────────────────── */
  section("J · Audit trail");
  const logs = await db.query(
    "select action, count(*)::int as n from audit_trail where action like 'ADVISOR%' group by action order by action");
  ok("advisor actions are audited", logs.rows.length > 0, JSON.stringify(logs.rows));
  for (const a of ["ADVISOR_ACCESS_GRANT", "ADVISOR_NOTE_CREATE"]) {
    ok(`audit log contains ${a}`, logs.rows.some((r) => r.action === a), JSON.stringify(logs.rows.map((r) => r.action)));
  }
} catch (e) {
  fail++; failures.push(`harness crash: ${e.message}`);
  console.error(e);
} finally {
  /* ── cleanup ───────────────────────────────────────────────────────── */
  try {
    if (advisorId) {
      await db.query("delete from advisor_note_replies where note_id in (select id from advisor_notes where author_user_id = $1)", [advisorId]);
      await db.query("delete from advisor_notes where author_user_id = $1", [advisorId]);
      await db.query("delete from advisor_visits where advisor_user_id = $1", [advisorId]);
      await db.query("delete from advisor_assignments where user_id = $1", [advisorId]);
      await db.query("delete from notifications where user_id = $1", [advisorId]);
      await db.query("delete from user_sessions where user_id = $1", [advisorId]).catch(() => {});
      await db.query("delete from organization_members where user_id = $1", [advisorId]).catch(() => {});
      await db.query("delete from users where id = $1", [advisorId]);
    }
    await db.query("delete from advisor_notes where title like $1", [`%${STAMP}%`]);
    await db.query("delete from ai_insights where title like 'Advisory Digest%'");
    await db.query("delete from audit_trail where action like 'ADVISOR%'");
  } catch (e) { console.log(`cleanup note: ${e.message}`); }
  await db.end();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(fail ? 1 : 0);
}
