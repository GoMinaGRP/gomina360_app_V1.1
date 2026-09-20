/**
 * Phase 0 authorization matrix:  anon / Owner / GM / BM(biz1) / BM(biz2) / Worker(biz1)
 * against the hardened routes. Run with the dev server on :3000.
 * Usage: node dev-tooling/phase0-authz-matrix.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = {
  owner: { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" },
  gm: { email: "abena.gm@gomina360.com", password: "GoMina@User2" },
  bm1: { email: "emmanuel@gomina360.com", password: "GoMina@User3" }, // biz 1
  bm2: { email: "kofi@gomina360.com", password: "GoMina@User4" }, // biz 2
  worker1: { email: "akua.donkor@gomina360.com", password: "GoMina@User10" }, // biz 1
};

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name} ${detail}`); }
}

async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-gomina-session": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* html etc. */ }
  return { status: res.status, json };
}

async function login(c) {
  const r = await call("/api/auth/login", "POST", c);
  return r.json?.sessionToken || null;
}

function noSecrets(blob, label) {
  return !/passwordHash|password_hash|passwordSalt|failedLoginAttempts|lockedUntil|\$2b\$|\$argon/.test(JSON.stringify(blob || {})) || (console.log(`   secrets leak in ${label}`), false);
}
const bizIdsIn = (blob) => [...JSON.stringify(blob || {}).matchAll(/"businessId"\s*:\s*(\d+)/g)].map(m => Number(m[1]));

// ── logins ──────────────────────────────────────────────────────────────
const t = {};
for (const [k, c] of Object.entries(CREDS)) {
  t[k] = await login(c);
  ok(`login ${k} (${c.email})`, !!t[k]);
}

// ── A. anonymous ────────────────────────────────────────────────────────
let r;
r = await call("/api/auth/me");                       ok("anon /api/auth/me → 401", r.status === 401, `${r.status}`);
r = await call("/api/logs/POULTRY-01");               ok("anon /api/logs/POULTRY-01 → 401 (F1)", r.status === 401, `${r.status}`);
r = await call("/api/electronics?businessId=6");      ok("anon /api/electronics → 401", r.status === 401, `${r.status}`);
r = await call("/api/enterprise");                    ok("anon /api/enterprise → 401 (F2)", r.status === 401, `${r.status}`);
r = await call("/api/users/workers?businessId=1");    ok("anon /api/users/workers → 401", r.status === 401, `${r.status}`);
r = await call("/api/assets/audit");                  ok("anon /api/assets/audit → 401", r.status === 401, `${r.status}`);
r = await call("/api/sales-documents");               ok("anon /api/sales-documents → 401", r.status === 401, `${r.status}`);

// ── B. F1: /api/logs/[businessCode] ────────────────────────────────────
r = await call("/api/logs/POULTRY-01", "GET", null, t.bm1);
ok("BM(biz1) logs own code → 200", r.status === 200, `${r.status}`);
r = await call("/api/logs/BLOCK-01", "GET", null, t.bm1);
ok("BM(biz1) logs other biz code → 403/404", r.status === 403 || r.status === 404, `${r.status}`);
r = await call("/api/logs/BLOCK-01", "GET", null, t.bm2);
ok("BM(biz2) logs own code (BLOCK-01) → 200", r.status === 200, `${r.status}`);
r = await call("/api/logs/BLOCK-01", "GET", null, t.owner);
ok("Owner logs any code → 200", r.status === 200, `${r.status}`);
r = await call("/api/logs/POULTRY-01", "GET", null, t.worker1);
ok("Worker(biz1) logs own code → 200", r.status === 200, `${r.status}`);

// ── C. F2: /api/enterprise (deletion-log view + QR lookup) ─────────────
r = await call("/api/enterprise?deletionLogs=1&module=SUPPLIERS", "GET", null, t.bm1);
ok("BM(biz1) /api/enterprise deletionLogs → 200", r.status === 200, `${r.status}`);
r = await call("/api/enterprise?deletionLogs=1&module=INVENTORY", "GET", null, t.owner);
ok("Owner /api/enterprise deletionLogs → 200", r.status === 200, `${r.status}`);
// QR lookup scoping: bm1 scanning a biz-2 inventory QR must NOT find it.
const pgC = new (createRequire(import.meta.url)("pg").Client)("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pgC.connect();
const qrRow = (await pgC.query(`SELECT qr_code FROM inventory_items WHERE business_id = 2 AND qr_code IS NOT NULL LIMIT 1`)).rows[0];
await pgC.end();
if (qrRow?.qr_code) {
  r = await call(`/api/enterprise?qr=${encodeURIComponent(qrRow.qr_code)}`, "GET", null, t.bm1);
  ok("BM(biz1) QR lookup of biz2 item → not found (scoped)", r.status === 200 && r.json?.found === false, `${r.status} ${JSON.stringify(r.json)}`);
  r = await call(`/api/enterprise?qr=${encodeURIComponent(qrRow.qr_code)}`, "GET", null, t.owner);
  ok("Owner QR lookup of biz2 item → found", r.status === 200 && r.json?.found === true, `${r.status}`);
}

// ── D. module READ scoping (electronics lives in biz 6) ────────────────
r = await call("/api/electronics?businessId=6", "GET", null, t.bm1);
ok("BM(biz1) electronics(biz6) → 403", r.status === 403, `${r.status}`);
r = await call("/api/electronics?businessId=1", "GET", null, t.bm1);
ok("BM(biz1) electronics(biz1) → 200", r.status === 200, `${r.status}`);
r = await call("/api/electronics?businessId=1", "GET", null, t.bm2);
ok("BM(biz2) electronics(biz1) → 403", r.status === 403, `${r.status}`);
r = await call("/api/electronics?businessId=6", "GET", null, t.worker1);
ok("Worker(biz1) electronics(biz6) → 403", r.status === 403, `${r.status}`);
r = await call("/api/electronics?businessId=1", "GET", null, t.worker1);
ok("Worker(biz1) electronics(biz1) → 200", r.status === 200, `${r.status}`);
r = await call("/api/electronics?businessId=6", "GET", null, t.gm);
ok("GM electronics(biz6) → 200 (grants)", r.status === 200, `${r.status}`);
r = await call("/api/electronics?businessId=6", "GET", null, t.owner);
ok("Owner electronics(biz6) → 200", r.status === 200, `${r.status}`);

// ── E. module WRITE denial (cross-business, both guard orders OK, no row) ──
r = await call("/api/electronics", "POST", { entity: "PRODUCT", businessId: 6, name: "TEST-BM1-XBIZ" }, t.bm1);
ok("BM(biz1) POST electronics(biz6) → not writable (403/400)", (r.status === 403 || r.status === 400) && r.json?.success !== true, `${r.status}`);
r = await call("/api/sales", "POST", { businessId: 2, cart: [] }, t.bm1);
ok("BM(biz1) POST sales(biz2) → not writable", (r.status === 403 || r.status === 400) && r.json?.success !== true, `${r.status}`);
r = await call("/api/sales", "POST", { businessId: 2, cart: [] }, t.worker1);
ok("Worker(biz1) POST sales(biz2) → not writable", (r.status === 403 || r.status === 400) && r.json?.success !== true, `${r.status}`);

// ── F. users/workers: secrets, scope, manager gate ─────────────────────
r = await call("/api/users/workers?businessId=1", "GET", null, t.bm1);
ok("BM(biz1) workers list ok + no secret material", r.status === 200 && noSecrets(r.json, "workers-bm1"), `${r.status}`);
r = await call("/api/users/workers?businessId=2", "GET", null, t.bm1);
ok("BM(biz1) workers(biz2) → 403", r.status === 403, `${r.status}`);
r = await call("/api/users/workers?businessId=6", "GET", null, t.worker1);
ok("Worker(biz1) workers(biz6) → 403", r.status === 403, `${r.status}`);
r = await call("/api/users/workers", "PATCH", { workerId: 11, action: "TOGGLE_ENABLE" }, t.worker1);
ok("Worker cannot TOGGLE_ENABLE coworker → 403", r.status === 403, `${r.status}`);
r = await call("/api/users/workers", "PATCH", { workerId: 12, action: "TOGGLE_ENABLE" }, t.bm1); // id12 worker biz2
ok("BM(biz1) cannot TOGGLE_ENABLE biz2 worker → 403", r.status === 403, `${r.status}`);
// positive: BM(biz1) create + delete a throwaway worker in own business
r = await call("/api/users/workers", "POST", { name: "TEST SecWorker", email: "test.secworker.phase0@gomina360.com", assignedBusinessId: 1, password: "TestP@ss123" }, t.bm1);
ok("BM(biz1) create TEST worker in own biz → 200/201", (r.status === 200 || r.status === 201) && r.json?.success !== false, `${r.status} ${JSON.stringify(r.json).slice(0,120)}`);
const testWorkerId = r.json?.user?.id || r.json?.worker?.id;
ok("created worker response is secret-free", !!testWorkerId && noSecrets(r.json, "workers-create"));
if (testWorkerId) {
  const d = await call(`/api/users/workers?workerId=${testWorkerId}`, "DELETE", null, t.bm1);
  ok("BM(biz1) delete own-biz TEST worker → 200", d.status === 200 && d.json?.success !== false, `${d.status}`);
}
r = await call("/api/users/workers", "POST", { name: "TEST XBiz", email: "test.xbiz.phase0@gomina360.com", assignedBusinessId: 6, password: "TestP@ss123" }, t.bm1);
ok("BM(biz1) cannot create worker in biz6 → 403", r.status === 403, `${r.status}`);

// ── G. sales-documents scoping ──────────────────────────────────────────
r = await call("/api/sales-documents", "GET", null, t.bm1);
ok("BM(biz1) sales-documents only in accessible scope",
  r.status === 200 && bizIdsIn(r.json).every(b => b === 1), `${r.status} ids=${bizIdsIn(r.json).join(",")}`);
r = await call("/api/sales-documents?businessId=2", "GET", null, t.bm1);
ok("BM(biz1) sales-documents?businessId=2 → 403", r.status === 403, `${r.status}`);
r = await call("/api/sales-documents", "GET", null, t.owner);
ok("Owner sales-documents → 200", r.status === 200, `${r.status}`);

// ── H. assets: role spoof + approval gate ───────────────────────────────
r = await call("/api/assets", "PATCH", { assetId: 1, actorRole: "OWNER", updates: { location: "TEST-SPOOF" } }, t.bm1);
ok("BM PATCH asset with actorRole=OWNER spoof → 403 (no approval)", r.status === 403, `${r.status}`);
// same for worker, plus access denial for bm2 on biz1 asset
r = await call("/api/assets", "PATCH", { assetId: 1, actorRole: "OWNER", updates: { location: "TEST-SPOOF" } }, t.worker1);
ok("Worker PATCH asset with actorRole=OWNER spoof → 403", r.status === 403, `${r.status}`);
// audit POST: worker1 on own biz asset — identity stamped from session
r = await call("/api/assets/audit", "POST", { assetId: 1, requestedAction: "EDIT", requestedByUserId: 999, requestedByName: "Mega Spoof", requestedByRole: "OWNER", detailsJson: { note: "phase0 test" } }, t.worker1);
ok("Worker create audit REQUEST on own-biz asset → 200", r.status === 200 && r.json?.success !== false, `${r.status}`);
const auditId = r.json?.log?.id;
const stamped = r.json?.log?.requestedByUserId;
ok("audit requester identity stamped from session (user 10, not 999)", !!auditId && Number(stamped) === 10, `stamped=${stamped}`);
r = await call("/api/assets/audit", "POST", { assetId: 2, requestedAction: "EDIT" }, t.bm1);
ok("BM(biz1) audit POST on biz2 asset → 403", r.status === 403, `${r.status}`);
// audit PATCH decisions
if (auditId) {
  r = await call("/api/assets/audit", "PATCH", { auditId, decision: "APPROVED" }, t.bm1);
  ok("BM cannot APPROVE audit → 403", r.status === 403, `${r.status}`);
  r = await call("/api/assets/audit", "PATCH", { auditId, decision: "APPROVED" }, t.worker1);
  ok("Worker cannot APPROVE audit → 403", r.status === 403, `${r.status}`);
  r = await call("/api/assets/audit", "PATCH", { auditId, decision: "REJECTED", approvedByUserId: 999, approvedByName: "Spoof Executive" }, t.owner);
  ok("Owner REJECT test audit → 200, approver stamped from session",
    r.status === 200 && Number(r.json?.log?.approvedByUserId) === 1 && r.json?.log?.status === "REJECTED",
    `${r.status} ${JSON.stringify(r.json?.log).slice(0, 150)}`);
}
// audit GET scoping
r = await call("/api/assets/audit", "GET", null, t.bm1);
ok("BM(biz1) audit GET scoped (no biz2 asset logs)", r.status === 200, `${r.status}`);

// ── I. assets/download: identity stamping + history scope ───────────────
r = await call("/api/assets/download", "POST", { downloadId: "TEST-PHASE0-DL-001", downloaderUserId: 1, downloaderName: "Kwame Mina", downloaderRole: "OWNER", downloaderBusinessId: 1, format: "CSV", recordCount: 1, qrCodeData: "phase0-test" }, t.worker1);
ok("Worker record download with spoofed identity → success", r.status === 200 && r.json?.success !== false, `${r.status}`);
ok("download stamped with session identity (user 10, WORKER)",
  Number(r.json?.download?.downloaderUserId) === 10 && r.json?.download?.downloaderRole === "WORKER",
  JSON.stringify({ u: r.json?.download?.downloaderUserId, role: r.json?.download?.downloaderRole }));
r = await call("/api/assets/download", "POST", { downloadId: "TEST-PHASE0-DL-002", downloaderBusinessId: 6, format: "CSV", recordCount: 1, qrCodeData: "x" }, t.worker1);
ok("Worker record download for biz6 → 403", r.status === 403, `${r.status}`);
r = await call("/api/assets/download?userId=1", "GET", null, t.worker1);
ok("Worker cannot read another user's download history → 403", r.status === 403, `${r.status}`);
r = await call("/api/assets/download", "GET", null, t.worker1);
ok("Worker own download history shows only own rows",
  r.status === 200 && (r.json?.downloads || []).every(d => Number(d.downloaderUserId) === 10), `${r.status}`);
r = await call("/api/assets/download", "GET", null, t.owner);
ok("Owner download history sees all", r.status === 200, `${r.status}`);

// ── J. checklists role param no longer authoritative ───────────────────
r = await call("/api/checklists?id=1&role=OWNER", "DELETE", null, t.bm2);
ok("BM(biz2) DELETE biz1 template with ?role=OWNER spoof → 403", r.status === 403, `${r.status}`);
r = await call("/api/checklists", "POST", { entity: "TEMPLATE", role: "OWNER", data: { businessId: 1, taskKey: "SPOOF_TEST", taskLabel: "Spoofed template", category: "OPS" } }, t.worker1);
ok("Worker POST checklist TEMPLATE with role=OWNER spoof → 403", r.status === 403, `${r.status}`);
// template id 1 must still exist (no accidental delete)
const tpl = await call("/api/checklists?businessId=1", "GET", null, t.owner);
ok("biz1 template #1 survived spoofed DELETE",
  tpl.status === 200 && JSON.stringify(tpl.json).includes("FEED_STOCK_CHECK"), `${tpl.status}`);

// ── K. DB ground-truth checks ──────────────────────────────────────────
const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();
const asset1 = await pg.query(`SELECT location FROM assets WHERE id = 1`);
ok("asset #1 NOT mutated by spoofed PATCHes", asset1.rows[0]?.location !== "TEST-SPOOF", asset1.rows[0]?.location);
const auditRow = await pg.query(`SELECT requested_by_user_id, requested_by_role, status, approved_by_user_id FROM asset_audit_logs WHERE details_json::text LIKE '%phase0 test%'`);
ok("DB: audit row stamped worker=10/WORKER, REJECTED by owner=1",
  auditRow.rows[0]?.requested_by_user_id === 10 && auditRow.rows[0]?.requested_by_role === "WORKER" &&
  auditRow.rows[0]?.status === "REJECTED" && auditRow.rows[0]?.approved_by_user_id === 1,
  JSON.stringify(auditRow.rows[0]));
const dlRow = await pg.query(`SELECT downloader_user_id, downloader_role FROM asset_downloads WHERE download_id = 'TEST-PHASE0-DL-001'`);
ok("DB: download row stamped user=10/WORKER (spoof rejected)",
  dlRow.rows[0]?.downloader_user_id === 10 && dlRow.rows[0]?.downloader_role === "WORKER",
  JSON.stringify(dlRow.rows[0]));
const ghost = await pg.query(`SELECT count(*)::int c FROM users WHERE email IN ('test.secworker.phase0@gomina360.com','test.xbiz.phase0@gomina360.com')`);
ok("DB: throwaway worker cleaned up, xbiz worker never created", ghost.rows[0].c === 0, `${ghost.rows[0].c}`);

// self-cleanup: remove the TEST audit/download/worker artifacts this run created
await pg.query(`DELETE FROM asset_audit_logs WHERE details_json::text LIKE '%phase0 test%'`);
await pg.query(`DELETE FROM asset_downloads WHERE download_id LIKE 'TEST-PHASE0-DL-%'`);
await pg.query(`DELETE FROM users WHERE email IN ('test.secworker.phase0@gomina360.com','test.xbiz.phase0@gomina360.com')`);
await pg.end();

console.log(`\n══ Phase 0 authz matrix: ${pass} pass / ${fail} fail ══`);
if (failures.length) { console.log("FAILED:", failures.join(" | ")); process.exit(1); }
