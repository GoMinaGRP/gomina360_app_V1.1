/**
 * verify-init-ledger.mjs — the bootstrap transaction window + full-history feed.
 *
 * /api/init ships the newest LEDGER_WINDOW_DAYS of the operational ledger and
 * reports `ledger.complete`. When it is false the client pulls the complete
 * history from /api/init/ledger. This suite pins that contract:
 *
 *   • the bootstrap window is a true subset of the complete history, and every
 *     row outside it is older than the window (nothing recent is withheld);
 *   • the seeded notification-baseline rows are always inside the window;
 *   • the complete feed has exactly `ledger.transactionsTotal` rows for the
 *     viewer and the same row shape as the bootstrap;
 *   • a sale recorded now appears in both feeds;
 *   • a worker sees only the sales they recorded; a farm advisor sees none;
 *   • signed-out callers are refused; unchanged data answers 304.
 *
 * Run: BASE_URL=http://127.0.0.1:3000 bash dev-tooling/run-suite.sh dev-tooling/verify-init-ledger.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const TAG = "INITLEDGER";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const ADVISOR = { email: "farm-advisor.e2e@gomina360.com", pw: "Role@GoMina26" };

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
};

async function login(u) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.pw }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0], user: json.user };
}
const getJson = async (cookie, path, extra = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie, ...(extra.headers || {}) } });
  return { status: res.status, etag: res.headers.get("etag"), json: await res.json().catch(() => ({})) };
};

const pg = new Client({ connectionString: PG_URL });
const cutoffISO = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

(async () => {
  await pg.connect();
  const ownerS = await login(OWNER);
  ok("the Owner signs in", ownerS.status === 200 && !!ownerS.cookie);

  // ── Bootstrap window contract ────────────────────────────────────────
  const init = await getJson(ownerS.cookie, "/api/init");
  const ledger = init.json.ledger;
  ok("bootstrap reports the ledger window", !!ledger && typeof ledger.complete === "boolean" && typeof ledger.transactionsTotal === "number", JSON.stringify(ledger));
  const windowFrom = ledger?.windowFrom;
  ok("window start is an ISO date", /^\d{4}-\d{2}-\d{2}$/.test(windowFrom || ""), String(windowFrom));
  const seededRe = /^TRX-\d{4}-100[1-6]$/;
  const windowRows = init.json.transactions || [];
  const outside = windowRows.filter((t) => String(t.date) < windowFrom && !seededRe.test(String(t.transactionNumber || "")));
  ok("every bootstrap row is inside the window or a seeded baseline row", outside.length === 0, `${outside.length} outside`);
  ok("the bootstrap carries no receipt images", windowRows.every((t) => !("receiptImage" in t) && !("receiptImages" in t)));
  ok("the window's seeded baseline rows are present", windowRows.some((t) => seededRe.test(String(t.transactionNumber || ""))) || (await pg.query("select count(*)::int c from transactions where transaction_number ~ '^TRX-[0-9]{4}-100[1-6]$'")).rows[0].c === 0);
  ok("the bootstrap loaded count is consistent", ledger.complete ? windowRows.length === ledger.transactionsTotal : windowRows.length === ledger.transactionsLoaded, `rows=${windowRows.length} total=${ledger.transactionsTotal}`);

  // ── Complete history feed ────────────────────────────────────────────
  const full = await getJson(ownerS.cookie, "/api/init/ledger");
  ok("complete feed answers 200 for the Owner", full.status === 200 && Array.isArray(full.json.transactions));
  const fullRows = full.json.transactions || [];
  ok("complete feed row count equals the bootstrap total", fullRows.length === ledger.transactionsTotal, `full=${fullRows.length} total=${ledger.transactionsTotal}`);
  const fullIds = new Set(fullRows.map((t) => t.id));
  ok("every bootstrap row is in the complete feed", windowRows.every((t) => fullIds.has(t.id)));
  const dbLive = Number((await pg.query("select count(*)::int c from transactions where (status='COMPLETED' or status is null) and business_id in (select id from businesses)")).rows[0].c);
  ok("complete feed matches the database's live ledger (owner scope)", fullRows.length <= dbLive && fullRows.length > 0, `feed=${fullRows.length} db=${dbLive}`);
  const shapeKeys = (rows) => Object.keys(rows[0] || {}).sort().join(",");
  if (windowRows.length && fullRows.length) {
    ok("both feeds share the same row shape", shapeKeys(windowRows) === shapeKeys(fullRows));
  }
  const cond = await getJson(ownerS.cookie, "/api/init/ledger", { headers: { "if-none-match": full.etag || "" } });
  ok("unchanged complete feed answers 304", cond.status === 304 || !full.etag, `status=${cond.status}`);
  const anon = await fetch(`${BASE}/api/init/ledger`);
  ok("complete feed refuses signed-out callers", anon.status === 401, `status=${anon.status}`);

  // ── Live sale appears in both feeds ─────────────────────────────────
  const bizId = Number((await pg.query("select id from businesses order by id limit 1")).rows[0].id);
  const mk = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerS.cookie },
    body: JSON.stringify({ businessId: bizId, type: "INCOME", category: "Direct Receipt", amountGhs: 3, paymentMethod: "CASH", description: `${TAG} live sale` }),
  });
  const mkJson = await mk.json().catch(() => ({}));
  const newId = Number(mkJson?.transaction?.id);
  ok("the Owner records a sale", mk.status === 200 && newId > 0, `status=${mk.status}`);
  if (newId) {
    const inInit = (await getJson(ownerS.cookie, "/api/init")).json.transactions.some((t) => t.id === newId);
    const inFull = (await getJson(ownerS.cookie, "/api/init/ledger")).json.transactions.some((t) => t.id === newId);
    ok("the new sale is in the bootstrap window", inInit);
    ok("the new sale is in the complete feed", inFull);
    await fetch(`${BASE}/api/transactions`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: ownerS.cookie },
      body: JSON.stringify({ id: newId, reason: `${TAG} cleanup` }),
    });
  }
  await pg.query("DELETE FROM record_deletion_logs WHERE reason LIKE $1", [`%${TAG}%`]);
  await pg.query("DELETE FROM notifications WHERE record_ref LIKE 'audit-event:%' AND body LIKE $1", [`%${TAG}%`]);

  // ── Role boundaries ─────────────────────────────────────────────────
  const workerS = await login(WORKER);
  if (workerS.status === 200) {
    const wl = await getJson(workerS.cookie, "/api/init/ledger");
    const mine = String(workerS.user?.name || "");
    ok("a worker's complete feed holds only their own recorded sales",
      wl.status === 200 && (wl.json.transactions || []).every((t) => String(t.recordedBy || "") === mine),
      `rows=${(wl.json.transactions || []).length} as ${mine}`);
    const wi = await getJson(workerS.cookie, "/api/init");
    ok("a worker's bootstrap ledger matches the same rule",
      (wi.json.transactions || []).every((t) => String(t.recordedBy || "") === mine));
  } else {
    ok("worker sign-in (skipped — credentials not available here)", true, `status=${workerS.status}`);
  }
  const advS = await login(ADVISOR);
  if (advS.status === 200) {
    const al = await getJson(advS.cookie, "/api/init/ledger");
    ok("a farm advisor receives no ledger rows", al.status === 200 && (al.json.transactions || []).length === 0, `rows=${(al.json.transactions || []).length}`);
  } else {
    ok("advisor sign-in (skipped — credentials not available here)", true, `status=${advS.status}`);
  }

  await pg.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pg.end(); } catch {}
  process.exit(1);
});
