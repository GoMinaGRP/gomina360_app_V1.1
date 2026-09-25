/**
 * verify-farm-advisor.mjs — Farm Advisor feature end-to-end verification.
 *
 * Covers the whole FARM-ADVISOR-DESIGN contract against the running app:
 *
 *   A · Account governance — only the OWNER creates FARM_ADVISOR accounts;
 *       no branch assignment, no management permissions may attach.
 *   B · Grants lifecycle — OWNER-only grant API; advisor sees ONLY granted
 *       units (API + slim init); cross-tenant unit data is 403; expiry and
 *       revocation cut access immediately; re-grant reactivates.
 *   C · Middleware default-deny — read-only farm-ops allowlist; every other
 *       API surface (finance/HR/users/exports/mutations) is 403 pre-route.
 *   D · Advisor notes CRUD — validation (category/priority/dates/links),
 *       AI analysis + benchmark corroboration, RESPOND/STATUS/EDIT flows,
 *       24h author edit-window (OWNER may always revise), no DELETE ever.
 *   E · Notifications & escalation — ADVISOR_NOTE_ADDED to unit staff (and
 *       the OWNER on HIGH), ADVISOR_NOTE_RESPONSE to the author,
 *       ADVISOR_FOLLOWUP_STATUS to both sides.
 *   F · Audit trail — GRANT_ACCESS / REVOKE_ACCESS / UPDATE_GRANT /
 *       ADVISOR_NOTE_ADDED / ADVISOR_NOTE_RESPONSE /
 *       ADVISOR_FOLLOWUP_STATUS_CHANGED rows all land.
 *   G · AI folding — business_insights memory absorbs advisor notes and is
 *       rebuilt (never double-counted) after an in-window EDIT.
 *   H · UI desktop + 375 px — advisor console, read-only farm modules
 *       (no Feed Mill / Finance tabs, no recording buttons, notes panel),
 *       OWNER manage console with the grant form; zero page errors.
 *   J · Users & Access onboarding UI — Register New Account → Farm Advisor
 *       creates the account AND grants units in one flow (password reveal,
 *       unit chips, expiry, scope); the users table shows advisor units;
 *       the inline access modal renews / revokes / re-activates through the
 *       same /api/advisor grants; advisor logs in with the revealed
 *       password. Desktop + 375 px.
 *   Z · Full self-cleanup — every row this suite creates is removed;
 *       business_insights is snapshot/restored byte-for-byte.
 *
 * Usage: node dev-tooling/verify-farm-advisor.mjs   (server on :3000)
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2" };
const BM1 = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" }; // POULTRY-01 branch manager
const WORKER1 = { email: "akua.donkor@gomina360.com", pass: "GoMina@User10" }; // POULTRY-01 worker
const ADVISOR = {
  email: "serwaa.advisor-verify@gomina360.com",
  name: "Dr. Serwaa Advisor-Verify",
  pass: "Advisor@Verify1",
};
// Created THROUGH the Register New Account UI in section J (one-flow
// onboarding: account + password + unit chips + expiry + scope).
const ADVISOR_UI = {
  email: "kwesi.advisor-verify@gomina360.com",
  name: "Kwesi Boateng Advisor-Verify",
};
// Section K: two advisors with DIFFERENT per-section access levels
// (A = narrow allowlists incl. an empty one, B = legacy all-sections grant).
const ADVISOR_SEC_A = { email: "ama.sec-verify@gomina360.com", name: "Ama Owusu Section-Verify", pass: "Advisor@SecA1" };
const ADVISOR_SEC_B = { email: "yao.sec-verify@gomina360.com", name: "Yao Mensah Section-Verify", pass: "Advisor@SecB1" };

const results = [];
const pageErrors = [];
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

/* ── API helpers (x-gomina-session token, same as phase0) ─────────────── */
async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* html */ }
  return { status: res.status, json };
}
async function login(creds) {
  const r = await call("/api/auth/login", "POST", { email: creds.email, password: creds.pass });
  return r.json?.sessionToken || null;
}

/* ── puppeteer helpers ────────────────────────────────────────────────── */
const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};
const uiLogin = async (page, creds) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 90000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 90000 });
  await sleep(1200);
};

/* ═══ SETUP ═══════════════════════════════════════════════════════════ */
await pg.connect();

// Resolve units + people BY CODE/EMAIL (never hardcode ids).
const biz = (code) => pg.query(`SELECT id, name, code FROM businesses WHERE code = $1`, [code]).then((r) => r.rows[0]);
const poultry = await biz("POULTRY-01");
const aqua = await biz("AQUA-01");
const livestock = await biz("LIVESTOCK-01");
if (!poultry || !aqua || !livestock) { console.error("FATAL: POULTRY-01 / AQUA-01 / LIVESTOCK-01 not found"); process.exit(1); }
const ownerRow = (await pg.query(`SELECT id FROM users WHERE email = $1`, [OWNER.email])).rows[0];
const bm1Row = (await pg.query(`SELECT id FROM users WHERE email = $1`, [BM1.email])).rows[0];
const flock = (await pg.query(
  `SELECT id, batch_number FROM poultry_flocks WHERE business_id = $1 ORDER BY id DESC LIMIT 1`, [poultry.id],
)).rows[0];

// Shared row-purge for everything this suite (or an earlier crashed run of
// it) creates. Patterns are advisor-specific, never id-range based.
async function purgeAdvisorRows(userId) {
  if (!userId) return;
  const noteIds = (await pg.query(
    `SELECT id FROM advisor_notes WHERE author_user_id = $1 OR title LIKE '%advisor-verify%'`, [userId],
  )).rows.map((x) => x.id);
  if (noteIds.length) {
    await pg.query(`DELETE FROM advisor_note_updates WHERE note_id = ANY($1)`, [noteIds]);
    await pg.query(`DELETE FROM advisor_notes WHERE id = ANY($1)`, [noteIds]);
  }
  await pg.query(
    `DELETE FROM notifications WHERE user_id = $1 OR (record_type = 'ADVISOR_NOTE' AND record_id = ANY($2)) OR (type LIKE 'ADVISOR%' AND record_id = ANY($2))`,
    [userId, noteIds.length ? noteIds : [-1]],
  );
  await pg.query(`DELETE FROM advisor_assignments WHERE user_id = $1`, [userId]);
  await pg.query(
    `DELETE FROM audit_trail WHERE actor_user_id = $1 OR (record_type = 'ADVISOR_NOTE' AND record_id = ANY($2)) OR (target_type = 'USER' AND target_label LIKE '%' || $3 || '%')`,
    [userId, noteIds.length ? noteIds : [-1], ADVISOR.name],
  );
  await pg.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
  await pg.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
  await pg.query(`DELETE FROM user_push_settings WHERE user_id = $1`, [userId]);
  await pg.query(`DELETE FROM organization_members WHERE user_id = $1`, [userId]);
}

/** business_insights is derived data rebuilt from the note streams. After the
 *  advisor's notes are purged, any insights row for our units whose note
 *  streams are now COMPLETELY empty is pure suite pollution from a crashed
 *  run — remove it so baselines start at zero. (If daily notes or other
 *  advisors' notes exist, the row is live data and stays untouched.) */
async function purgeOrphanInsights(userId) {
  await pg.query(
    `DELETE FROM business_insights bi
     WHERE bi.business_id = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM daily_notes d WHERE d.business_id = bi.business_id)
       AND NOT EXISTS (SELECT 1 FROM advisor_notes a WHERE a.business_id = bi.business_id AND a.author_user_id <> $2)`,
    [[poultry.id, aqua.id], userId],
  );
}

// Pre-clean any earlier run of this suite so we always start from zero
// (the API-created, UI-created and section-verification advisor accounts).
for (const adv of [ADVISOR, ADVISOR_UI, ADVISOR_SEC_A, ADVISOR_SEC_B]) {
  const prior = (await pg.query(`SELECT id FROM users WHERE email = $1`, [adv.email])).rows[0];
  if (prior) {
    await purgeAdvisorRows(prior.id);
    await purgeOrphanInsights(prior.id);
    await pg.query(`DELETE FROM users WHERE id = $1 AND email = $2`, [prior.id, adv.email]);
  }
}
let advisorUserId = null;

// Snapshot business_insights for every unit we may touch (restore in Z).
const insightsSnap = (await pg.query(
  `SELECT * FROM business_insights WHERE business_id = ANY($1)`, [[poultry.id, aqua.id]],
)).rows;

// K aqua seed baseline (safe default: current max ids).
const kBase = {
  pond: (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM aquaculture_ponds`)).rows[0].m,
  batch: (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM aquaculture_batches`)).rows[0].m,
};
// Baseline max-ids so Z can remove only OUR rows.
const base = {
  notifications: (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m,
  audit: (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM audit_trail`)).rows[0].m,
  notes: (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM advisor_notes`)).rows[0].m,
};

/* ═══ A · ACCOUNT GOVERNANCE ═══════════════════════════════════════════ */
console.log("\n── A · Account governance ──");
const tOwner = await login(OWNER);
const tGm = await login(GM);
const tBm1 = await login(BM1);
const tWorker1 = await login(WORKER1);
ok("A0 logins (owner/gm/bm1/worker)", !!tOwner && !!tGm && !!tBm1 && !!tWorker1);

let r = await call("/api/users", "POST", { name: "Nope Advisor", email: "nope.advisor-verify@gomina360.com", role: "FARM_ADVISOR", password: "Xx12345!" }, tGm);
ok("A1 GM creating FARM_ADVISOR → 403 (OWNER only)", r.status === 403, `${r.status}`);
r = await call("/api/users", "POST", { name: "Nope Advisor", email: "nope.advisor-verify@gomina360.com", role: "FARM_ADVISOR", assignedBusinessId: poultry.id, password: "Xx12345!" }, tOwner);
ok("A2 advisor with branch assignment → 400", r.status === 400, `${r.status}`);
r = await call("/api/users", "POST", { name: "Nope Advisor", email: "nope.advisor-verify@gomina360.com", role: "FARM_ADVISOR", canManageRecords: true, password: "Xx12345!" }, tOwner);
ok("A3 advisor with management permission → 400 (read-only by design)", r.status === 400, `${r.status}`);

r = await call("/api/users", "POST", { name: ADVISOR.name, email: ADVISOR.email, role: "FARM_ADVISOR", password: ADVISOR.pass }, tOwner);
ok("A4 OWNER creates the FARM_ADVISOR account", r.status === 200 && r.json?.user?.role === "FARM_ADVISOR", JSON.stringify(r.json).slice(0, 140));
if (r.json?.user?.id) advisorUserId = r.json?.user?.id;
const tAdvisor = await login(ADVISOR);
ok("A5 advisor can log in", !!tAdvisor);

// Advisor with zero grants sees an empty world.
r = await call("/api/init", "GET", null, tAdvisor);
ok("A6 ungranted advisor init → 200, zero businesses", r.status === 200 && (r.json?.businesses || []).length === 0, `biz=${(r.json?.businesses || []).length}`);

/* ═══ B · GRANTS LIFECYCLE ═════════════════════════════════════════════ */
console.log("\n── B · Grants lifecycle ──");
r = await call("/api/advisor", "POST", { userId: advisorUserId, businessIds: [poultry.id] }, tBm1);
ok("B1 BM (not grant manager) POST /api/advisor → 403", r.status === 403, `${r.status}`);
r = await call("/api/advisor", "POST", { userId: advisorUserId, businessIds: [poultry.id], validUntil: day(-1) }, tOwner);
ok("B2 grant with past validUntil → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor", "GET", null, tAdvisor);
ok("B3 advisor GET /api/advisor (own view) before grants → empty", r.status === 200 && (r.json?.assignments || []).length === 0, JSON.stringify(r.json).slice(0, 120));

r = await call("/api/advisor", "POST", { userId: advisorUserId, businessIds: [poultry.id], scopeNote: "Poultry health & production review", validUntil: null }, tOwner);
ok("B4 OWNER grants POULTRY-01", r.status === 200 && r.json?.granted === 1, JSON.stringify(r.json).slice(0, 120));
const grantRow = (await pg.query(`SELECT id FROM advisor_assignments WHERE user_id = $1 AND business_id = $2`, [advisorUserId, poultry.id])).rows[0];
ok("B5 assignment row exists", !!grantRow);

r = await call("/api/advisor", "GET", null, tOwner);
ok("B6 OWNER GET /api/advisor → grant-manager view", r.status === 200 && (r.json?.assignments || []).some((a) => a.userId === advisorUserId), "");
ok("B7 grant-manager view lists the advisor + businesses", (r.json?.advisors || []).some((a) => a.id === advisorUserId) && (r.json?.businesses || []).some((b) => b.code === "POULTRY-01"), "");

/* ═══ C · AUTHZ MATRIX + DEFAULT-DENY MIDDLEWARE ═══════════════════════ */
console.log("\n── C · Authz matrix (advisor granted POULTRY-01 only) ──");
r = await call("/api/init", "GET", null, tAdvisor);
const initBiz = (r.json?.businesses || []).map((b) => b.code);
ok("C1 advisor init lists ONLY POULTRY-01", r.status === 200 && initBiz.length === 1 && initBiz[0] === "POULTRY-01", JSON.stringify(initBiz));
ok("C2 init slimmed: employees/transactions/customers empty, users self-only",
  (r.json?.employees || []).length === 0 && (r.json?.transactions || []).length === 0 && (r.json?.customers || []).length === 0 && (r.json?.users || []).every((u) => u.id === advisorUserId),
  `emp=${(r.json?.employees || []).length} trx=${(r.json?.transactions || []).length}`);
ok("C3 init slimmed: inventory prices stripped, metrics financials zeroed",
  (r.json?.inventory || []).every((i) => i.costPriceGhs == null && i.sellingPriceGhs == null) &&
  (r.json?.metrics || []).every((m) => (m.revenueGhs || 0) === 0 && (m.netProfitGhs || 0) === 0),
  "");

r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tAdvisor);
ok("C4 advisor reads granted unit poultry data → 200", r.status === 200, `${r.status}`);
r = await call(`/api/aquaculture?businessId=${aqua.id}`, "GET", null, tAdvisor);
ok("C5 advisor reads NON-granted AQUA-01 → 403 (cross-tenant)", r.status === 403, `${r.status}`);
r = await call(`/api/poultry?businessId=${aqua.id}`, "GET", null, tAdvisor);
ok("C6 poultry payload of another unit → 403", r.status === 403, `${r.status}`);
r = await call("/api/logs/POULTRY-01", "GET", null, tAdvisor);
ok("C7 advisor /api/logs of granted unit → 200", r.status === 200, `${r.status}`);
r = await call("/api/logs/AQUA-01", "GET", null, tAdvisor);
ok("C8 advisor /api/logs of other unit → 403/404", r.status === 403 || r.status === 404, `${r.status}`);

// Default-deny: every management surface is 403 BEFORE route code.
for (const [path, method, label] of [
  ["/api/users", "GET", "user directory"],
  ["/api/users", "POST", "user creation"],
  ["/api/employees", "GET", "HR"],
  ["/api/transactions", "GET", "finance"],
  ["/api/assets", "GET", "assets"],
  ["/api/audit", "GET", "audit center"],
  ["/api/enterprise", "GET", "enterprise"],
  ["/api/inventory", "POST", "inventory mutation"],
  [`/api/poultry?businessId=${poultry.id}`, "POST", "poultry mutation"],
  [`/api/aquaculture?businessId=${poultry.id}`, "POST", "aquaculture mutation"],
  ["/api/backups", "GET", "backups"],
  ["/api/exports", "GET", "exports"],
]) {
  r = await call(path, method, method === "GET" ? null : { businessId: poultry.id, name: "x" }, tAdvisor);
  ok(`C9 advisor ${method} ${path.split("?")[0]} (${label}) → 403`, r.status === 403, `${r.status}`);
}
r = await call("/api/branding", "GET", null, tAdvisor);
ok("C10 advisor GET /api/branding → 200 (allowlisted)", r.status === 200, `${r.status}`);
r = await call("/api/advisor-notes", "GET", null, tAdvisor);
ok("C11 advisor GET /api/advisor-notes (no params) → 400 (needs businessId)", r.status === 400, `${r.status}`);
r = await call(`/api/advisor-notes?businessId=${aqua.id}`, "GET", null, tAdvisor);
ok("C12 advisor notes of NON-granted unit → 403", r.status === 403, `${r.status}`);
r = await call(`/api/advisor-notes?businessId=${poultry.id}`, "GET", null, tAdvisor);
ok("C13 advisor notes of granted unit → 200", r.status === 200, `${r.status}`);
r = await call(`/api/advisor-notes?businessId=${poultry.id}`, "GET", null, tWorker1);
ok("C14 worker cannot read advisor notes → 403", r.status === 403, `${r.status}`);
r = await call(`/api/advisor-notes?businessId=${poultry.id}`, "GET", null, tBm1);
ok("C15 unit Branch Manager reads advisor notes → 200", r.status === 200, `${r.status}`);

/* ═══ D · NOTES CRUD, EDIT-WINDOW, NO-DELETE ═══════════════════════════ */
console.log("\n── D · Advisor notes CRUD ──");
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "WEIRD", title: "Bad category", body: "This should be rejected outright." }, tAdvisor);
ok("D1 invalid category → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", priority: "EXTREME", title: "Bad priority", body: "This should be rejected outright." }, tAdvisor);
ok("D2 invalid priority → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "no", body: "This should be rejected outright." }, tAdvisor);
ok("D3 short title → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "Valid title", body: "short" }, tAdvisor);
ok("D4 short body → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "Future note", body: "Dated in the future, must be rejected.", noteDate: day(3) }, tAdvisor);
ok("D5 future noteDate → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "Ancient note", body: "Back-dated far too much, must be rejected.", noteDate: day(-45) }, tAdvisor);
ok("D6 noteDate older than 30 days → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: aqua.id, category: "HEALTH_DISEASE", title: "Wrong unit", body: "Filing on a unit the advisor cannot access." }, tAdvisor);
ok("D7 note on NON-granted unit → 403", r.status === 403, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, flockId: 999999, category: "HEALTH_DISEASE", title: "Ghost flock", body: "Linked flock does not exist in this unit." }, tAdvisor);
ok("D8 flock link outside unit → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "Worker tries", body: "Workers do not file advisor notes." }, tWorker1);
ok("D9 worker filing a note → 403", r.status === 403, `${r.status}`);

// The real note: HIGH health observation, flock-linked, follow-up tomorrow.
r = await call("/api/advisor-notes", "POST", {
  businessId: poultry.id,
  flockId: flock?.id || null,
  category: "HEALTH_DISEASE",
  priority: "HIGH",
  title: "Heat stress signs in layer house",
  body: "Observation visit: noticeable panting and reduced feed intake during the afternoon heat; recommend improved ventilation and electrolyte supplementation, and review water line flow.",
  noteDate: day(0),
  followUpDueDate: day(1),
}, tAdvisor);
ok("D10 advisor files a valid HIGH note → 200", r.status === 200 && r.json?.note?.id, JSON.stringify(r.json).slice(0, 200));
const note = r.json?.note || {};
ok("D11 note starts OPEN with author = advisor", note.followUpStatus === "OPEN" && note.authorUserId === advisorUserId, `${note.followUpStatus}`);
ok("D12 AI analysis returned (summary + severity)", !!r.json?.analysis?.summary && !!r.json?.analysis?.severity, JSON.stringify(r.json?.analysis || {}).slice(0, 120));
ok("D13 corroboration block present", r.json?.corroboration && typeof r.json.corroboration.verdict === "string", JSON.stringify(r.json?.corroboration || {}).slice(0, 160));
ok("D14 severity floor: HIGH note is never below WATCH", ["WATCH", "URGENT"].includes(r.json?.analysis?.severity), `${r.json?.analysis?.severity}`);

// Thread: staff response auto-advances OPEN → IN_PROGRESS.
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "RESPOND", note: "We have opened the ridge vents and started electrolytes in the drinking water today." }, tBm1);
ok("D15 BM responds → 200", r.status === 200, `${r.status}`);
ok("D16 first staff response moves OPEN → IN_PROGRESS", r.json?.note?.followUpStatus === "IN_PROGRESS", `${r.json?.note?.followUpStatus}`);
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "RESPOND", note: "Thank you — please keep the water lines flushed daily and send me the mortality count tomorrow." }, tAdvisor);
ok("D17 advisor responds on own note → 200", r.status === 200, `${r.status}`);

// Status lifecycle.
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "STATUS", status: "BANANA" }, tBm1);
ok("D18 invalid status → 400", r.status === 400, `${r.status}`);
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "STATUS", status: "ADDRESSED" }, tWorker1);
ok("D19 worker cannot change status → 403", r.status === 403, `${r.status}`);
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "STATUS", status: "ADDRESSED", note: "Ventilation fixed, intake recovering." }, tBm1);
ok("D20 BM marks ADDRESSED → 200", r.status === 200 && r.json?.note?.followUpStatus === "ADDRESSED", `${r.status}`);
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "STATUS", status: "ADDRESSED" }, tBm1);
ok("D21 same-status transition → 400", r.status === 400, `${r.status}`);

// EDIT inside the author's 24h window.
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "EDIT", priority: "CRITICAL", body: "Observation visit: noticeable panting and reduced feed intake during the afternoon heat; two birds found dead near the far cages. Recommend immediate ventilation audit, electrolyte supplementation, and a review of water line flow." }, tAdvisor);
ok("D22 author edits within 24h → 200 + re-analysis", r.status === 200 && !!r.json?.analysis, `${r.status}`);
r = await call("/api/advisor-notes", "PATCH", { id: note.id, action: "EDIT", title: "no" }, tAdvisor);
ok("D23 edit violating title rule → 400", r.status === 400, `${r.status}`);

// Aged note: author's window is closed, OWNER may still revise.
const aged = (await pg.query(`
  INSERT INTO advisor_notes (business_id, branch_code, note_date, category, priority, title, body,
    follow_up_status, ai_summary, ai_issues, ai_severity, ai_flags, author_user_id, author_name, author_role, created_at)
  VALUES ($1, 'POULTRY-01', $2, 'GENERAL', 'LOW', 'Aged advisor-verify note', 'This note is three days old so the author edit window has closed by now.', 'OPEN', 'Aged note for edit-window verification.', '[]'::jsonb, 'INFO', '[]'::jsonb, $3, $4, 'FARM_ADVISOR', NOW() - INTERVAL '3 days')
  RETURNING id`, [poultry.id, day(-3), advisorUserId, ADVISOR.name])).rows[0];
r = await call("/api/advisor-notes", "PATCH", { id: aged.id, action: "EDIT", body: "The advisor should not be able to edit this aged note anymore at all." }, tAdvisor);
ok("D24 author edit AFTER 24h → 403", r.status === 403, `${r.status}`);
r = await call("/api/advisor-notes", "PATCH", { id: aged.id, action: "EDIT", body: "The OWNER may always revise an advisor note, even after the window." }, tOwner);
ok("D25 OWNER edits aged note → 200", r.status === 200, `${r.status}`);

// No DELETE — notes are history.
r = await call(`/api/advisor-notes?noteId=${note.id}`, "DELETE", null, tOwner);
ok("D26 DELETE method → 405 (notes are never erased)", r.status === 405, `${r.status}`);

// Single-note thread view.
r = await call(`/api/advisor-notes?noteId=${note.id}`, "GET", null, tAdvisor);
const threadActions = (r.json?.updates || []).map((u) => u.action);
ok("D27 noteId view returns the immutable thread", r.status === 200 && threadActions.includes("ADD") && threadActions.includes("RESPOND") && threadActions.includes("STATUS_CHANGE") && threadActions.includes("EDIT"), JSON.stringify(threadActions));

/* ═══ E · NOTIFICATIONS & ESCALATION ═══════════════════════════════════ */
console.log("\n── E · Notifications & escalation ──");
const ntf = (type, userId, recordId) => pg.query(
  `SELECT id FROM notifications WHERE type = $1 AND user_id = $2 AND record_id = $3`, [type, userId, recordId],
).then((x) => x.rows.length);
ok("E1 BM1 got ADVISOR_NOTE_ADDED for the HIGH note", (await ntf("ADVISOR_NOTE_ADDED", bm1Row.id, note.id)) >= 1);
ok("E2 OWNER got ADVISOR_NOTE_ADDED (HIGH escalation)", (await ntf("ADVISOR_NOTE_ADDED", ownerRow.id, note.id)) >= 1);
ok("E3 advisor got ADVISOR_NOTE_RESPONSE after staff reply", (await ntf("ADVISOR_NOTE_RESPONSE", advisorUserId, note.id)) >= 1);
ok("E4 advisor got ADVISOR_FOLLOWUP_STATUS after ADDRESSED", (await ntf("ADVISOR_FOLLOWUP_STATUS", advisorUserId, note.id)) >= 1);

/* ═══ F · AUDIT TRAIL ══════════════════════════════════════════════════ */
console.log("\n── F · Audit trail ──");
const auditCount = (action, where, params) => pg.query(
  `SELECT COUNT(*)::int c FROM audit_trail WHERE action = $1 AND ${where}`, [action, ...params],
).then((x) => x.rows[0].c);
ok("F1 GRANT_ACCESS rows for the grant", (await auditCount("GRANT_ACCESS", `target_label LIKE '%' || $2 || '%'`, [ADVISOR.name])) >= 1);
ok("F2 ADVISOR_NOTE_ADDED audit row", (await auditCount("ADVISOR_NOTE_ADDED", `record_id = $2`, [note.id])) >= 1);
ok("F3 ADVISOR_NOTE_RESPONSE audit row", (await auditCount("ADVISOR_NOTE_RESPONSE", `record_id = $2`, [note.id])) >= 1);
ok("F4 ADVISOR_FOLLOWUP_STATUS_CHANGED audit row", (await auditCount("ADVISOR_FOLLOWUP_STATUS_CHANGED", `record_id = $2`, [note.id])) >= 1);

/* ═══ G · AI FOLDING INTO BUSINESS_INSIGHTS ════════════════════════════ */
console.log("\n── G · AI memory folding ──");
const insights = (await pg.query(`SELECT * FROM business_insights WHERE business_id = $1`, [poultry.id])).rows[0];
const snapIns = insightsSnap.find((x) => x.business_id === poultry.id);
ok("G1 insights row exists for the unit", !!insights);
if (insights) {
  ok("G2 notesAnalyzed grew (advisor notes fold in)",
    insights.notes_analyzed > (snapIns?.notes_analyzed ?? 0),
    `${snapIns?.notes_analyzed ?? 0} → ${insights.notes_analyzed}`);
  ok("G3 lastNoteDate = our note's day", insights.last_note_date === day(0), String(insights.last_note_date));
  ok("G4 history non-empty with a summary", (insights.history || []).length >= 1 && String((insights.history || [])[0]?.summary || "").length > 0);
}

/* ═══ H · EXPIRY, REVOCATION, REACTIVATION ═════════════════════════════ */
console.log("\n── H · Expiry / revoke / reactivate ──");
// Expire the grant by SQL (the API rightly refuses to create already-past dates).
await pg.query(`UPDATE advisor_assignments SET valid_until = $1 WHERE user_id = $2 AND business_id = $3`, [day(-1), advisorUserId, poultry.id]);
r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tAdvisor);
ok("H1 expired grant → poultry data 403", r.status === 403, `${r.status}`);
r = await call("/api/init", "GET", null, tAdvisor);
ok("H2 expired grant → init lists no businesses", (r.json?.businesses || []).length === 0, JSON.stringify((r.json?.businesses || []).map((b) => b.code)));
r = await call("/api/advisor", "GET", null, tAdvisor);
const expiredA = (r.json?.assignments || []).find((a) => a.businessId === poultry.id);
ok("H3 advisor sees the assignment flagged expired", r.status === 200 && expiredA?.expired === true && expiredA?.effective === false, JSON.stringify(expiredA || {}).slice(0, 140));
r = await call("/api/advisor-notes", "POST", { businessId: poultry.id, category: "HEALTH_DISEASE", title: "Expired access", body: "Filing with an expired grant must fail." }, tAdvisor);
ok("H4 filing a note with expired grant → 403", r.status === 403, `${r.status}`);

// Re-grant reactivates the SAME row.
r = await call("/api/advisor", "POST", { userId: advisorUserId, businessIds: [poultry.id] }, tOwner);
ok("H5 re-grant after expiry restores access (row updated)", r.status === 200 && (r.json?.granted || 0) + (r.json?.reactivated || 0) >= 1, JSON.stringify(r.json));
r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tAdvisor);
ok("H6 access restored after re-grant", r.status === 200, `${r.status}`);

// Revocation.
r = await call("/api/advisor", "PATCH", { assignmentId: grantRow.id, isActive: false, reason: "Engagement paused" }, tBm1);
ok("H7 BM cannot revoke (not grant manager) → 403", r.status === 403, `${r.status}`);
r = await call("/api/advisor", "PATCH", { assignmentId: grantRow.id, isActive: false, reason: "Engagement paused" }, tOwner);
ok("H8 OWNER revokes → 200", r.status === 200, `${r.status}`);
r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tAdvisor);
ok("H9 revoked → poultry data 403", r.status === 403, `${r.status}`);
r = await call("/api/init", "GET", null, tAdvisor);
ok("H10 revoked → init lists no businesses", (r.json?.businesses || []).length === 0);
ok("F5 REVOKE_ACCESS audit row", (await auditCount("REVOKE_ACCESS", `target_label LIKE '%' || $2 || '%'`, [ADVISOR.name])) >= 1);

// Re-grant once more for the UI section.
r = await call("/api/advisor", "POST", { userId: advisorUserId, businessIds: [poultry.id], scopeNote: "UI verification pass" }, tOwner);
ok("H11 re-grant after revoke REACTIVATES the row", r.status === 200 && r.json?.reactivated === 1, JSON.stringify(r.json));

/* ═══ I · UI — DESKTOP + 375px ═════════════════════════════════════════ */
console.log("\n── I · UI (desktop + 375px) ──");
const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { ...process.env, LD_LIBRARY_PATH: "/tmp/al2023/lib" },
});

const freshContext = async () => {
  try { return await browser.createBrowserContext(); }
  catch { return await browser.createIncognitoBrowserContext(); }
};
try {
  // ── Advisor desktop ──
  const ctxA = await freshContext();
  const page = await ctxA.newPage();
  hookPage(page, "advisor-desktop");
  await page.setViewport({ width: 1440, height: 900 });
  await uiLogin(page, ADVISOR);
  await page.waitForSelector('[data-testid="advisor-console"]', { timeout: 60000 });
  ok("I1 advisor lands on the Advisor Console", true);
  ok("I2 sidebar shows the Advisor Console nav", !!(await page.$('[data-testid="advisor-console-tab"]')));
  const headerText = await page.evaluate(() => (document.querySelector('[data-testid="nav-sidebar"]')?.textContent || "").replace(/\s+/g, " "));
  ok("I3 sidebar header 'My Farm Units (1)'", /My Farm Units \(1\)/.test(headerText), headerText.slice(0, 80));
  ok("I4 MONITOR chip on POULTRY-01", !!(await page.$('[data-testid="sidebar-chip-advisor-POULTRY-01"]')));
  ok("I5 advisor has NO 'Farm Advisors' manage button", !(await page.$('[data-testid="sidebar-advisor-manage"]')));
  ok("I6 advisor engagement card for POULTRY-01", !!(await page.$('[data-testid="advisor-engagement-POULTRY-01"]')));
  ok("I7 console composer present", !!(await page.$('[data-testid="advisor-console-new-note"]')));

  // Open the granted unit → read-only poultry module.
  const opened = await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (!btn) return false;
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return true;
  });
  ok("I8 POULTRY-01 unit button clickable", opened);
  await page.waitForSelector('[data-testid="poultry-advisor-readonly-chip"]', { timeout: 60000 });
  ok("I9 poultry module shows ADVISOR · READ-ONLY chip", true);
  ok("I10 Feed Mill tab hidden", !(await page.$('[data-testid="poultry-tab-FEED_MILL"]')));
  ok("I11 Finance tab hidden", !(await page.$('[data-testid="poultry-tab-FINANCE"]')));
  ok("I12 Record Expense button hidden", !(await page.$('[data-testid="poultry-open-expense"]')));
  ok("I13 no 'New Flock' add button", !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "New Flock"))));
  await page.waitForSelector('[data-testid="advisor-notes-panel"]', { timeout: 60000 });
  ok("I14 Advisor Notes panel mounted on the dashboard", true);
  ok("I15 notes panel offers Add (advisor composes)", !!(await page.$('[data-testid="advisor-note-add-btn"]')));
  const tabCount = await page.evaluate(() => document.querySelectorAll('button[data-testid^="poultry-tab-"]').length);
  ok("I16 visible poultry tabs (dashboard/flocks/feed/water/health/production/stock/checklist/AI)", tabCount >= 7 && tabCount <= 9, `${tabCount} tabs`);

  // ── Advisor 375px (own context: the desktop session must not leak in) ──
  const ctxM = await freshContext();
  const pageM = await ctxM.newPage();
  hookPage(pageM, "advisor-375");
  await pageM.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await uiLogin(pageM, ADVISOR);
  await pageM.waitForSelector('[data-testid="advisor-console"]', { timeout: 60000 });
  ok("I17 375px: console renders", true);
  const overflow375 = await pageM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("I18 375px: no horizontal overflow on console", overflow375 <= 2, `${overflow375}px`);
  await pageM.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageM.waitForSelector('[data-testid="poultry-advisor-readonly-chip"]', { timeout: 60000 });
  const overflow375b = await pageM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("I19 375px: read-only module renders without overflow", overflow375b <= 2, `${overflow375b}px`);
  await ctxM.close();

  // ── OWNER manage console ──
  const ctxO = await freshContext();
  const pageO = await ctxO.newPage();
  hookPage(pageO, "owner-manage");
  await pageO.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageO, OWNER);
  await pageO.waitForSelector('[data-testid="sidebar-advisor-manage"]', { timeout: 60000 });
  ok("I20 OWNER sidebar has 'Farm Advisors'", true);
  await pageO.click('[data-testid="sidebar-advisor-manage"]');
  await pageO.waitForSelector('[data-testid="advisor-console"]', { timeout: 60000 });
  await pageO.waitForSelector('[data-testid="advisor-grant-form"]', { timeout: 60000 });
  ok("I21 OWNER manage console shows the grant form", true);
  ok("I22 grant form lists our advisor", !!(await pageO.$(`[data-testid="advisor-grant-row-${grantRow.id}"]`)));
  const revokeBtn = await pageO.$(`[data-testid="advisor-grant-revoke-${grantRow.id}"]`);
  ok("I23 grant row offers revoke", !!revokeBtn);
  await ctxO.close();
  await ctxA.close();
} catch (e) {
  ok("I* UI section completed without fatal error", false, String(e).slice(0, 200));
}

ok("I24 zero console/page errors in UI pass", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

/* ═══ J · USERS & ACCESS ONBOARDING UI (one-flow create + inline manage) ═ */
console.log("\n── J · Users & Access onboarding & management UI ──");
const setNativeValue = async (page, sel, value) => {
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const proto = el instanceof HTMLSelectElement
      ? Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    proto.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, sel, value);
};

try {
  const ctxJ = await freshContext();
  const pageJ = await ctxJ.newPage();
  hookPage(pageJ, "users-access");
  await pageJ.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageJ, OWNER);

  // open Users & Access (Enterprise Users)
  const navOk = await pageJ.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((b) => (b.textContent || "").includes("Enterprise Users"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  ok("J1 Users & Access opens", navOk);
  await pageJ.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "Register New Account"), { timeout: 30000 });

  // ── one-flow create: account + password + units + expiry + scope ──
  await pageJ.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Register New Account");
    btn.scrollIntoView({ block: "center" });
    btn.click();
  });
  await pageJ.waitForFunction(() => document.body.textContent.includes("Register User Account"), { timeout: 30000 });
  await setNativeValue(pageJ, 'input[placeholder="Enter full name"]', ADVISOR_UI.name).catch(async () => {
    // fallback: first text input in the modal
    await pageJ.evaluate(() => {
      const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
      const inputs = [...modal.querySelectorAll("input[type=text]")];
      const set = (el, v) => {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        proto.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(inputs[0], "NAME:" + "");
    });
  });
  // Fill name/email/phone/password via the modal's text inputs (order: name, email, phone)
  await pageJ.evaluate((name, email) => {
    const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
    const inputs = [...modal.querySelectorAll("input")];
    const text = inputs.filter((i) => i.type === "text" || i.type === "email" || !i.type);
    const set = (el, v) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      proto.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set(text[0], name);
    set(text[1], email);
  }, ADVISOR_UI.name, ADVISOR_UI.email);
  // role → Farm Advisor
  await pageJ.evaluate(() => {
    const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
    const sel = [...modal.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "FARM_ADVISOR"));
    const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    proto.call(sel, "FARM_ADVISOR");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await pageJ.waitForSelector('[data-testid="user-create-unit-chips"]', { timeout: 10000 });
  ok("J2 advisor onboarding block appears (units/expiry/scope)", true);
  // password + POULTRY-01 chip + expiry + scope
  await setNativeValue(pageJ, '[data-testid="user-create-password"]', "UiAdvisor@Verify1");
  await pageJ.click('[data-testid="user-create-biz-POULTRY-01"]');
  await setNativeValue(pageJ, '[data-testid="user-create-valid-until"]', day(30));
  await setNativeValue(pageJ, '[data-testid="user-create-scope-note"]', "UI one-flow onboarding check");
  const farmChip = await pageJ.$eval('[data-testid="user-create-biz-POULTRY-01"]', (el) => (el.textContent || "").includes("FARM"));
  ok("J3 farm unit chip carries · FARM identification", !!farmChip);
  // submit
  await pageJ.evaluate(() => {
    const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
    const btn = [...modal.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Save Record"));
    btn.click();
  });
  await pageJ.waitForSelector('[data-testid="user-created-password"]', { timeout: 30000 });
  const uiPassword = await pageJ.$eval('[data-testid="user-created-password"]', (el) => (el.textContent || "").trim());
  ok("J4 one-time credentials revealed after creation", uiPassword.length >= 4, uiPassword.slice(0, 4) + "…");
  const grantedTxt = await pageJ.evaluate(() => document.body.textContent.includes("Farm-unit access granted"));
  ok("J5 units granted in the same flow", grantedTxt);
  await pageJ.evaluate(() => {
    const done = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Done");
    if (done) done.click();
  });
  await sleep(1000);

  // ── users table row shows the advisor's units ──
  const uiAdvisorRow = (await pg.query(`SELECT id FROM users WHERE email = $1`, [ADVISOR_UI.email])).rows[0];
  ok("J6 UI-created advisor account exists", !!uiAdvisorRow, "");
  const uiGrants = (await pg.query(`SELECT * FROM advisor_assignments WHERE user_id = $1`, [uiAdvisorRow.id])).rows;
  ok("J7 grant row created with expiry + scope",
    uiGrants.length === 1 && uiGrants[0].valid_until === day(30) && /UI one-flow/.test(uiGrants[0].scope_note || ""),
    JSON.stringify(uiGrants[0] || {}).slice(0, 120));
  await pageJ.waitForSelector(`[data-testid="usr-advisor-units-${uiAdvisorRow.id}"]`, { timeout: 30000 });
  const unitsTxt = await pageJ.$eval(`[data-testid="usr-advisor-units-${uiAdvisorRow.id}"]`, (el) => (el.textContent || "").replace(/\s+/g, " "));
  ok("J8 users table shows '1 unit · 1 active'", /1 unit · 1 active/.test(unitsTxt), unitsTxt);
  const rowRole = await pageJ.evaluate((id) => {
    const row = document.querySelector(`[data-testid="usr-advisor-manage-${id}"]`)?.closest("tr");
    return (row?.textContent || "").includes("FARM ADVISOR") && (row?.textContent || "").includes("READ-ONLY · NOTES");
  }, uiAdvisorRow.id);
  ok("J9 advisor row: FARM ADVISOR badge + READ-ONLY · NOTES perms", rowRole);

  // ── inline access modal: renew (expiry+scope), revoke, re-activate ──
  await pageJ.click(`[data-testid="usr-advisor-manage-${uiAdvisorRow.id}"]`);
  await pageJ.waitForSelector('[data-testid="usr-advisor-modal"]', { timeout: 30000 });
  const grantId = uiGrants[0].id;
  await pageJ.waitForSelector(`[data-testid="usr-grant-row-${grantId}"]`, { timeout: 30000 });
  ok("J10 access modal lists the grant (same assignments as the console)", true);
  // renew: change expiry to +60d and save
  await setNativeValue(pageJ, `[data-testid="usr-grant-expiry-${grantId}"]`, day(60));
  await pageJ.click(`[data-testid="usr-grant-save-${grantId}"]`);
  await sleep(1200);
  const renewed = (await pg.query(`SELECT valid_until FROM advisor_assignments WHERE id = $1`, [grantId])).rows[0];
  ok("J11 renew: expiry updated to +60d via inline save", renewed?.valid_until === day(60), String(renewed?.valid_until));
  // revoke from the modal
  await pageJ.click(`[data-testid="usr-grant-revoke-${grantId}"]`);
  await sleep(1200);
  const revokedRow = (await pg.query(`SELECT is_active FROM advisor_assignments WHERE id = $1`, [grantId])).rows[0];
  ok("J12 revoke from Users & Access cuts the grant", revokedRow?.is_active === false, String(revokedRow?.is_active));
  // advisor login (fresh context) → no units
  const tUiAdvisor = await login({ email: ADVISOR_UI.email, pass: uiPassword });
  ok("J13 UI-created advisor logs in with the revealed password", !!tUiAdvisor);
  r = await call("/api/init", "GET", null, tUiAdvisor);
  ok("J14 revoked → advisor init lists no businesses", (r.json?.businesses || []).length === 0);
  // re-activate from the modal (still open on the OWNER page)
  await pageJ.click(`[data-testid="usr-grant-reactivate-${grantId}"]`);
  await sleep(1200);
  const reactivated = (await pg.query(`SELECT is_active FROM advisor_assignments WHERE id = $1`, [grantId])).rows[0];
  ok("J15 re-activate restores the grant", reactivated?.is_active === true);
  r = await call("/api/init", "GET", null, tUiAdvisor);
  ok("J16 advisor regains POULTRY-01", (r.json?.businesses || []).some((b) => b.code === "POULTRY-01"));

  // ── the SAME data drives the Farm Advisors console ──
  const consoleConsistent = (await pg.query(`SELECT COUNT(*)::int c FROM advisor_assignments WHERE user_id = $1`, [uiAdvisorRow.id])).rows[0].c;
  ok("J17 exactly one grant row — no duplicate access system", consoleConsistent === 1, `${consoleConsistent}`);

  // ── advisor sees engagement card with scope + expiry ──
  const ctxJA = await freshContext();
  const pageJA = await ctxJA.newPage();
  hookPage(pageJA, "ui-advisor");
  await pageJA.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageJA, { email: ADVISOR_UI.email, pass: uiPassword });
  await pageJA.waitForSelector('[data-testid="advisor-engagement-POULTRY-01"]', { timeout: 60000 });
  const engTxt = await pageJA.$eval('[data-testid="advisor-engagement-POULTRY-01"]', (el) => (el.textContent || "").replace(/\s+/g, " "));
  ok("J18 engagement card shows scope + expiry from the UI grant", /UI one-flow onboarding check/.test(engTxt) && new RegExp(day(60)).test(engTxt), engTxt.slice(0, 120));
  await ctxJA.close();

  // ── 375px: users table + access modal ──
  const ctxJM = await freshContext();
  const pageJM = await ctxJM.newPage();
  hookPage(pageJM, "users-375");
  await pageJM.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await uiLogin(pageJM, OWNER);
  await pageJM.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((b) => (b.textContent || "").includes("Enterprise Users"));
    if (btn) btn.click();
  });
  await pageJM.waitForSelector(`[data-testid="usr-advisor-manage-${uiAdvisorRow.id}"]`, { timeout: 60000 });
  const ov1 = await pageJM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("J19 375px: Users & Access renders without overflow", ov1 <= 2, `${ov1}px`);
  await pageJM.click(`[data-testid="usr-advisor-manage-${uiAdvisorRow.id}"]`);
  await pageJM.waitForSelector('[data-testid="usr-advisor-modal"]', { timeout: 30000 });
  const ov2 = await pageJM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const modalVisible = await pageJM.$eval('[data-testid="usr-advisor-modal"]', (el) => el.getBoundingClientRect().width <= 375 + 2 && el.getBoundingClientRect().width > 200);
  ok("J20 375px: access modal fits the viewport", ov2 <= 2 && modalVisible, `${ov2}px w=${modalVisible}`);
  await ctxJM.close();
  await ctxJ.close();
} catch (e) {
  ok("J* Users & Access UI section completed without fatal error", false, String(e).slice(0, 220));
}



/* ═══ K · PER-SECTION VISIBILITY (multi-advisor, API + UI, desktop+375) ═ */
console.log("\n── K · Per-section advisor visibility ──");
let secAId = null, secBId = null, secGrantA = null;
try {
  // Two advisors, different levels: A = narrow per-unit allowlists (plus an
  // intentionally EMPTY livestock list), B = legacy grant with NO section
  // list (null = all sections).
  r = await call("/api/users", "POST", { name: ADVISOR_SEC_A.name, email: ADVISOR_SEC_A.email, role: "FARM_ADVISOR", password: ADVISOR_SEC_A.pass }, tOwner);
  ok("K1 OWNER creates section advisor A", r.status === 200 && r.json?.user?.role === "FARM_ADVISOR", JSON.stringify(r.json).slice(0, 120));
  secAId = r.json?.user?.id || null;
  r = await call("/api/users", "POST", { name: ADVISOR_SEC_B.name, email: ADVISOR_SEC_B.email, role: "FARM_ADVISOR", password: ADVISOR_SEC_B.pass }, tOwner);
  ok("K2 OWNER creates section advisor B", r.status === 200 && r.json?.user?.role === "FARM_ADVISOR", JSON.stringify(r.json).slice(0, 120));
  secBId = r.json?.user?.id || null;
  const tSecA = await login(ADVISOR_SEC_A);
  const tSecB = await login(ADVISOR_SEC_B);
  ok("K3 both section advisors log in", !!tSecA && !!tSecB);

  // AQUA-01 starts empty on fresh DBs — seed one pond + batch as OWNER so
  // the STOCK section demonstrably carries data (removed again in Z).
  r = await call("/api/aquaculture", "POST", { entity: "POND", data: { businessId: aqua.id, pondId: "SEC-CAGE-1", name: "Sec-Verify Cage", type: "CAGE", capacityLiters: 10000, status: "ACTIVE" } }, tOwner);
  ok("K4 seed aqua pond for STOCK data", r.status === 200, JSON.stringify(r.json).slice(0, 120));
  const secPondId = r.json?.item?.id || null;
  r = await call("/api/aquaculture", "POST", { entity: "BATCH", data: { businessId: aqua.id, batchNumber: "SEC-BATCH-1", pondId: secPondId, species: "NILE_TILAPIA", initialCount: 500, currentCount: 480, avgWeightGrams: 120, status: "GROWING" } }, tOwner);
  ok("K5 seed aqua batch for STOCK data", r.status === 200, JSON.stringify(r.json).slice(0, 120));

  // Grant A: poultry [FLOCKS, HEALTH], aqua [STOCK], livestock [] (nothing).
  r = await call("/api/advisor", "POST", {
    userId: secAId,
    businessIds: [poultry.id, aqua.id, livestock.id],
    validUntil: day(30),
    sectionsByBusiness: { [poultry.id]: ["FLOCKS", "HEALTH"], [aqua.id]: ["STOCK"], [livestock.id]: [] },
  }, tOwner);
  ok("K6 grant A with per-unit sections (3 units)", r.status === 200 && r.json?.granted === 3, JSON.stringify(r.json).slice(0, 120));
  // Invalid keys are rejected BEFORE any write…
  r = await call("/api/advisor", "POST", { userId: secAId, businessIds: [poultry.id], sectionsByBusiness: { [poultry.id]: ["NOPE"] } }, tOwner);
  ok("K7 invalid section key → 400", r.status === 400, `${r.status}`);
  // …and grant B the legacy way (no sections at all = ALL sections).
  r = await call("/api/advisor", "POST", { userId: secBId, businessIds: [poultry.id], validUntil: day(30) }, tOwner);
  ok("K8 grant B without section list (legacy = all)", r.status === 200 && r.json?.granted === 1, JSON.stringify(r.json).slice(0, 120));

  secGrantA = (await pg.query(`SELECT id, sections FROM advisor_assignments WHERE user_id = $1 AND business_id = $2`, [secAId, poultry.id])).rows[0];
  ok("K9 grant row persists sections jsonb", !!secGrantA && JSON.stringify(secGrantA.sections) === '["FLOCKS","HEALTH"]', JSON.stringify(secGrantA?.sections));

  // ── A's POULTRY payload: allowed datasets ship, denied are stripped ──
  r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tSecA);
  const pa = r.json || {};
  ok("K10 A poultry: flocks visible", Array.isArray(pa.flocks) && pa.flocks.length > 0, `${(pa.flocks || []).length}`);
  ok("K11 A poultry: health records visible", Array.isArray(pa.healthRecords) && pa.healthRecords.length > 0, `${(pa.healthRecords || []).length}`);
  ok("K12 A poultry: feed stripped", (pa.feedLogs || []).length === 0);
  ok("K13 A poultry: water stripped", (pa.waterLogs || []).length === 0);
  ok("K14 A poultry: weights (growth) stripped", (pa.weightLogs || []).length === 0);
  ok("K15 A poultry: production stripped", (pa.production || []).length === 0);
  ok("K16 A poultry: checklist rows stripped", (pa.checklists || []).length === 0);
  ok("K17 A poultry: benchmark profiles stripped", (pa.benchmarkProfiles || []).length === 0);
  ok("K18 A poultry: advisorSections echo", JSON.stringify(pa.advisorSections) === '["FLOCKS","HEALTH"]', JSON.stringify(pa.advisorSections));

  r = await call(`/api/checklists?businessId=${poultry.id}`, "GET", null, tSecA);
  ok("K19 A poultry checklist API → 403 (section denied)", r.status === 403, `${r.status}`);

  // ── A's AQUA payload: STOCK only ─────────────────────────────────────
  r = await call(`/api/aquaculture?businessId=${aqua.id}`, "GET", null, tSecA);
  const qa = r.json || {};
  ok("K20 A aqua: batches (stock) visible", (qa.batches || []).length === 1, `${(qa.batches || []).length}`);
  ok("K21 A aqua: ponds stripped", (qa.ponds || []).length === 0);
  ok("K22 A aqua: feed/water/harvest/weights/benchmark stripped",
    (qa.feedLogs || []).length === 0 && (qa.waterLogs || []).length === 0 && (qa.harvests || []).length === 0 &&
    (qa.weightLogs || []).length === 0 && (qa.benchmarkProfiles || []).length === 0);
  r = await call(`/api/checklists?businessId=${aqua.id}`, "GET", null, tSecA);
  ok("K23 A aqua checklist (HEALTH section) → 403", r.status === 403, `${r.status}`);

  // ── A's LIVESTOCK: empty section list = nothing at all ────────────────
  r = await call(`/api/logs/LIVESTOCK-01`, "GET", null, tSecA);
  ok("K24 A livestock ops logs → 403 (no sections)", r.status === 403, `${r.status}`);

  // ── A's init payload: section map + stripped buckets ──────────────────
  r = await call(`/api/init`, "GET", null, tSecA);
  const ia = r.json || {};
  ok("K25 A init: advisorSections map per unit",
    JSON.stringify(ia.advisorSections?.[poultry.id]) === '["FLOCKS","HEALTH"]' &&
    JSON.stringify(ia.advisorSections?.[aqua.id]) === '["STOCK"]' &&
    JSON.stringify(ia.advisorSections?.[livestock.id]) === '[]',
    JSON.stringify(ia.advisorSections || null).slice(0, 160));
  ok("K26 A init: livestock log bucket stripped", (ia.specializedLogs?.livestock || []).length === 0);
  ok("K27 A init: checklist entries stripped for denied sections",
    !(ia.checklists?.entries || []).some((e) => Number(e.businessId) === Number(poultry.id)),
    `${(ia.checklists?.entries || []).filter((e) => Number(e.businessId) === Number(poultry.id)).length} poultry entries`);

  // ── Mutations stay blocked for section advisors too ───────────────────
  r = await call(`/api/poultry`, "POST", { businessId: poultry.id, entity: "FEED", flockId: flock.id, feedType: "MASH", quantityKg: 5 }, tSecA);
  ok("K28 A POST poultry feed → 403", r.status === 403, `${r.status}`);
  const anyEntry = (await pg.query(`SELECT id FROM checklist_entries WHERE business_id = $1 ORDER BY id LIMIT 1`, [poultry.id])).rows[0];
  r = await call(`/api/checklists`, "PATCH", { entity: "ENTRY", id: anyEntry?.id, isCompleted: true }, tSecA);
  ok("K29 A PATCH checklist entry (toggle) → 403", r.status === 403, `${r.status}`);

  // ── B (legacy all-sections grant) is the regression baseline ──────────
  r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tSecB);
  const pb = r.json || {};
  ok("K30 B (no section list) sees every dataset",
    (pb.feedLogs || []).length > 0 && (pb.weightLogs || []).length > 0 && (pb.benchmarkProfiles || []).length > 0 && pb.advisorSections === null,
    `feed=${(pb.feedLogs || []).length} weights=${(pb.weightLogs || []).length} bench=${(pb.benchmarkProfiles || []).length} secs=${JSON.stringify(pb.advisorSections)}`);

  // ── Owner narrows A's poultry sections via PATCH ──────────────────────
  r = await call("/api/advisor", "PATCH", { assignmentId: secGrantA.id, sections: ["FLOCKS"] }, tOwner);
  ok("K31 owner PATCH narrows A to FLOCKS", r.status === 200, JSON.stringify(r.json).slice(0, 100));
  r = await call(`/api/poultry?businessId=${poultry.id}`, "GET", null, tSecA);
  ok("K32 A poultry: health now stripped after PATCH", ((r.json || {}).healthRecords || []).length === 0);
  r = await call("/api/advisor", "PATCH", { assignmentId: secGrantA.id, sections: ["BOGUS"] }, tOwner);
  ok("K33 PATCH with invalid sections → 400", r.status === 400, `${r.status}`);
  r = await call("/api/advisor", "PATCH", { assignmentId: secGrantA.id, sections: ["FLOCKS", "HEALTH"] }, tSecA);
  ok("K34 advisor cannot PATCH own sections → 403", r.status === 403, `${r.status}`);
  // Restore the full two-section allowlist for the UI pass below.
  r = await call("/api/advisor", "PATCH", { assignmentId: secGrantA.id, sections: ["FLOCKS", "HEALTH"] }, tOwner);
  ok("K34b owner restores A's poultry sections for the UI pass", r.status === 200, `${r.status}`);
} catch (e) {
  ok("K* API section completed without fatal error", false, String(e).slice(0, 220));
}

/* ── K · UI pass: section-filtered modules, desktop + 375px ───────────── */
try {
  // Advisor A desktop — poultry shows exactly FLOCKS + HEALTH.
  const ctxK = await freshContext();
  const pageK = await ctxK.newPage();
  hookPage(pageK, "sec-advisor-a");
  await pageK.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageK, ADVISOR_SEC_A);
  await pageK.waitForSelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]', { timeout: 60000 });
  await pageK.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageK.waitForSelector('[data-testid="poultry-advisor-readonly-chip"]', { timeout: 60000 });
  ok("K35 A UI: Flocks & Health tabs visible",
    !!(await pageK.$('[data-testid="poultry-tab-FLOCKS"]')) && !!(await pageK.$('[data-testid="poultry-tab-HEALTH"]')));
  ok("K36 A UI: all other poultry tabs hidden",
    !(await pageK.$('[data-testid="poultry-tab-DASHBOARD"]')) && !(await pageK.$('[data-testid="poultry-tab-FEED"]')) &&
    !(await pageK.$('[data-testid="poultry-tab-WATER"]')) && !(await pageK.$('[data-testid="poultry-tab-PRODUCTION"]')) &&
    !(await pageK.$('[data-testid="poultry-tab-INVENTORY"]')) && !(await pageK.$('[data-testid="poultry-tab-CHECKLIST"]')) &&
    !(await pageK.$('[data-testid="poultry-tab-AI_KNOWLEDGE"]')));
  ok("K37 A UI: header stats hidden (dashboard denied)", !(await pageK.$('[data-testid="poultry-header-stats"]')));
  ok("K38 A UI: no record-weight button (growth denied + read-only)", !(await pageK.$('[data-testid="poa-record-weight"]')));
  const bodyK = await pageK.evaluate(() => (document.body.textContent || "").replace(/\s+/g, " "));
  ok("K39 A UI: lands on first permitted tab (Flock & Batch workspace)", /Flock & Batch Management/.test(bodyK));

  // Advisor A desktop — aqua shows exactly Fish Stock & Batches.
  await pageK.waitForSelector('[data-testid="sidebar-chip-advisor-AQUA-01"]', { timeout: 60000 });
  await pageK.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-AQUA-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageK.waitForSelector('[data-testid="aqua-advisor-readonly-chip"]', { timeout: 60000 });
  ok("K40 A UI: aqua Stock tab visible, all others hidden",
    !!(await pageK.$('[data-testid="aqua-tab-STOCK"]')) &&
    !(await pageK.$('[data-testid="aqua-tab-DASHBOARD"]')) && !(await pageK.$('[data-testid="aqua-tab-PONDS"]')) &&
    !(await pageK.$('[data-testid="aqua-tab-FEED"]')) && !(await pageK.$('[data-testid="aqua-tab-WATER"]')) &&
    !(await pageK.$('[data-testid="aqua-tab-HEALTH"]')) && !(await pageK.$('[data-testid="aqua-tab-HARVEST"]')));
  ok("K41 A UI: no fish record-weight button", !(await pageK.$('[data-testid="fga-record-weight"]')));

  // Advisor A desktop — livestock with an empty section list is locked.
  await pageK.waitForSelector('[data-testid="sidebar-chip-advisor-LIVESTOCK-01"]', { timeout: 60000 });
  await pageK.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-LIVESTOCK-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageK.waitForSelector('[data-testid="lk-advisor-locked"]', { timeout: 60000 });
  ok("K42 A UI: livestock module locked (no sections)", !!(await pageK.$('[data-testid="lk-advisor-locked"]')));
  ok("K43 A UI: livestock tab bar absent", !(await pageK.$('[data-testid="lk-tabs"]')));
  await ctxK.close();

  // Advisor B desktop — legacy all-sections grant stays fully read-only.
  const ctxKB = await freshContext();
  const pageKB = await ctxKB.newPage();
  hookPage(pageKB, "sec-advisor-b");
  await pageKB.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageKB, ADVISOR_SEC_B);
  await pageKB.waitForSelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]', { timeout: 60000 });
  await pageKB.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageKB.waitForSelector('[data-testid="poultry-advisor-readonly-chip"]', { timeout: 60000 });
  const bTabs = await pageKB.evaluate(() =>
    ["DASHBOARD", "FLOCKS", "FEED", "WATER", "HEALTH", "PRODUCTION", "INVENTORY", "CHECKLIST", "AI_KNOWLEDGE"]
      .filter((k) => !!document.querySelector(`[data-testid="poultry-tab-${k}"]`)).length);
  ok("K44 B UI: all 9 standard poultry tabs visible", bTabs === 9, `${bTabs}/9`);
  ok("K45 B UI: record-weight button hidden (read-only)", !(await pageKB.$('[data-testid="poa-record-weight"]')));
  await pageKB.click('[data-testid="poultry-tab-CHECKLIST"]');
  await pageKB.waitForSelector('[data-testid^="dcp-task-"]', { timeout: 60000 });
  const taskModes = await pageKB.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="dcp-task-"]')];
    return { total: rows.length, readonly: rows.filter((x) => (x.getAttribute("data-testid") || "").endsWith("-readonly")).length };
  });
  ok("K46 B UI: checklist tasks render read-only (no toggle)", taskModes.total > 0 && taskModes.readonly === taskModes.total,
    `${taskModes.readonly}/${taskModes.total}`);
  await ctxKB.close();

  // Advisor A on a 375px phone — the section-filtered module must fit.
  const ctxK3 = await freshContext();
  const pageK3 = await ctxK3.newPage();
  hookPage(pageK3, "sec-advisor-375");
  await pageK3.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await uiLogin(pageK3, ADVISOR_SEC_A);
  await pageK3.waitForSelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]', { timeout: 60000 });
  await pageK3.evaluate(() => {
    const chip = document.querySelector('[data-testid="sidebar-chip-advisor-POULTRY-01"]');
    const btn = chip ? chip.closest("button") : null;
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageK3.waitForSelector('[data-testid="poultry-advisor-readonly-chip"]', { timeout: 60000 });
  const ovK3 = await pageK3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("K47 A 375px: section-filtered module renders without overflow", ovK3 <= 2, `${ovK3}px`);
  await ctxK3.close();

  // OWNER: Users & Access modal carries the per-grant section editor.
  const ctxKO = await freshContext();
  const pageKO = await ctxKO.newPage();
  hookPage(pageKO, "sec-owner");
  await pageKO.setViewport({ width: 1440, height: 900 });
  await uiLogin(pageKO, OWNER);
  await pageKO.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((b) => (b.textContent || "").includes("Enterprise Users"));
    if (btn) btn.click();
  });
  await pageKO.waitForSelector(`[data-testid="usr-advisor-manage-${secAId}"]`, { timeout: 60000 });
  await pageKO.click(`[data-testid="usr-advisor-manage-${secAId}"]`);
  await pageKO.waitForSelector('[data-testid="usr-advisor-modal"]', { timeout: 30000 });
  await pageKO.waitForSelector('[data-testid="usr-grant-sec-picker-POULTRY-01"]', { timeout: 30000 });
  ok("K48 owner modal: section picker visible for the poultry grant", true);
  const feedOn = await pageKO.$eval('[data-testid="usr-grant-sec-POULTRY-01-FEED"]', (el) => (el.className || "").includes("emerald"));
  ok("K49 owner modal: FEED chip currently off for A", !feedOn);
  await pageKO.click('[data-testid="usr-grant-sec-POULTRY-01-FEED"]');
  await pageKO.waitForSelector(`[data-testid="usr-grant-save-${secGrantA.id}"]`, { timeout: 10000 });
  await pageKO.click(`[data-testid="usr-grant-save-${secGrantA.id}"]`);
  await sleep(1500);
  const savedSecs = (await pg.query(`SELECT sections FROM advisor_assignments WHERE id = $1`, [secGrantA.id])).rows[0]?.sections;
  ok("K50 owner modal: saving sections persists (FEED added)",
    Array.isArray(savedSecs) && ["FLOCKS", "HEALTH", "FEED"].every((k) => savedSecs.includes(k)), JSON.stringify(savedSecs));

  // Register form: selecting a farm unit reveals its section picker.
  // (Close the advisor-access modal first — its overlay would swallow the
  // register modal's chip clicks.)
  await pageKO.click('[data-testid="usr-advisor-modal"] button[aria-label="Close"]');
  await pageKO.waitForFunction(() => !document.querySelector('[data-testid="usr-advisor-modal"]'), { timeout: 10000 });
  await pageKO.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Register New Account");
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
  });
  await pageKO.waitForFunction(() => document.body.textContent.includes("Register User Account"), { timeout: 30000 });
  await pageKO.evaluate(() => {
    const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
    const sel = modal ? [...modal.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "FARM_ADVISOR")) : null;
    if (!sel) return false;
    const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    proto.call(sel, "FARM_ADVISOR");
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  await pageKO.waitForSelector('[data-testid="user-create-unit-chips"]', { timeout: 10000 });
  await pageKO.click('[data-testid="user-create-biz-POULTRY-01"]');
  await pageKO.waitForSelector('[data-testid="usr-create-sec-picker-POULTRY-01"]', { timeout: 10000 });
  ok("K51 register form: section picker appears for the selected farm unit", true);
  const waterOn1 = await pageKO.$eval('[data-testid="usr-create-sec-POULTRY-01-WATER"]', (el) => (el.className || "").includes("emerald"));
  await pageKO.click('[data-testid="usr-create-sec-POULTRY-01-WATER"]');
  const waterOn2 = await pageKO.$eval('[data-testid="usr-create-sec-POULTRY-01-WATER"]', (el) => (el.className || "").includes("emerald"));
  ok("K52 register form: section chip toggles off", waterOn1 && !waterOn2, `${waterOn1} → ${waterOn2}`);
  // Close the register modal without saving (cancel button of the modal).
  await pageKO.evaluate(() => {
    const modal = [...document.querySelectorAll(".fixed.inset-0")].find((d) => (d.textContent || "").includes("Register User Account"));
    const cancel = modal ? [...modal.querySelectorAll("button")].find((b) => /cancel/i.test((b.textContent || "").trim())) : null;
    if (cancel) cancel.click();
  });
  await pageKO.waitForFunction(() => !document.body.textContent.includes("Register User Account"), { timeout: 10000 }).catch(() => {});
  await ctxKO.close();
} catch (e) {
  ok("K* UI section completed without fatal error", false, String(e).slice(0, 220));
}
ok("K53 zero console/page errors through the section UI pass", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

/* ═══ Z · CLEANUP ══════════════════════════════════════════════════════ */
console.log("\n── Z · Cleanup ──");
try {
  // Everything this suite touched, in FK-safe order (no FKs, but logical order).
  await purgeAdvisorRows(advisorUserId);
  await purgeOrphanInsights(advisorUserId);
  await pg.query(`DELETE FROM users WHERE id = $1 AND email = $2`, [advisorUserId, ADVISOR.email]);
  const uiPrior = (await pg.query(`SELECT id FROM users WHERE email = $1`, [ADVISOR_UI.email])).rows[0];
  if (uiPrior) {
    await purgeAdvisorRows(uiPrior.id);
    await purgeOrphanInsights(uiPrior.id);
    await pg.query(`DELETE FROM users WHERE id = $1 AND email = $2`, [uiPrior.id, ADVISOR_UI.email]);
  }
  // Purge the negative-test account if it ever leaked in.
  await pg.query(`DELETE FROM users WHERE email = 'nope.advisor-verify@gomina360.com'`);
  // Section K advisors (grants die with purgeAdvisorRows).
  for (const adv of [ADVISOR_SEC_A, ADVISOR_SEC_B]) {
    const row = (await pg.query(`SELECT id FROM users WHERE email = $1`, [adv.email])).rows[0];
    if (row) {
      await purgeAdvisorRows(row.id);
      await pg.query(`DELETE FROM users WHERE id = $1 AND email = $2`, [row.id, adv.email]);
    }
  }
  // Remove the K-seeded aqua pond + batch (baseline-scoped, never live data).
  await pg.query(`DELETE FROM aquaculture_batches WHERE id > $1`, [kBase.batch]);
  await pg.query(`DELETE FROM aquaculture_ponds WHERE id > $1`, [kBase.pond]);

  // business_insights: byte-for-byte restore of the snapshotted rows.
  await pg.query(`DELETE FROM business_insights WHERE business_id = ANY($1)`, [[poultry.id, aqua.id]]);
  for (const row of insightsSnap) {
    await pg.query(
      `INSERT INTO business_insights (business_id, notes_analyzed, last_note_date, rolling_summary, issue_register, category_trends, history, updated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.business_id, row.notes_analyzed, row.last_note_date, row.rolling_summary,
       JSON.stringify(row.issue_register), JSON.stringify(row.category_trends), JSON.stringify(row.history), row.updated_at, row.created_at],
    );
  }
  const leftovers = (await pg.query(`SELECT COUNT(*)::int c FROM advisor_notes WHERE author_user_id = $1`, [advisorUserId])).rows[0].c;
  ok("Z1 no advisor-verify rows remain", leftovers === 0, `${leftovers}`);
  const userGone = (await pg.query(`SELECT COUNT(*)::int c FROM users WHERE email = $1`, [ADVISOR.email])).rows[0].c;
  ok("Z2 advisor-verify user removed", userGone === 0);
  const insightsRestored = (await pg.query(`SELECT COUNT(*)::int c FROM business_insights WHERE business_id = ANY($1)`, [[poultry.id, aqua.id]])).rows[0].c;
  ok("Z3 business_insights restored to snapshot", insightsRestored === insightsSnap.length, `${insightsRestored}/${insightsSnap.length}`);
} catch (e) {
  ok("Z cleanup completed", false, String(e).slice(0, 200));
}

await pg.end();
await browser.close().catch(() => {});

console.log(`\n═══ FARM ADVISOR VERIFICATION: ${pass} passed, ${fail} failed ═══`);
if (fail) {
  console.log("FAILURES:");
  results.filter((x) => !x.pass).forEach((x) => console.log(`  ❌ ${x.name}`));
  process.exit(1);
}
