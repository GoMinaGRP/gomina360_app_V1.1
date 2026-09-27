// Verify suite — Low-stock reorder alerts (P3): detection against
// min_stock_threshold, status normalization, deduped team notifications,
// severity levels and manager-only triggering. Restores every touched row.
//
// Run: node dev-tooling/verify-low-stock.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { id: 10, email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const client = new pg.Client(DB);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

async function login(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  return { ok: r.ok, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const api = async (cookie, method, path) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie } });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

let item = null;
let orig = { qty: null, status: null };
const today = new Date().toLocaleDateString("en-CA");
const recordRef = `low-stock:1:${today}`;

try {
  const ownerS = await login(OWNER);
  const akuaS = await login(AKUA);
  ok("logins", ownerS.ok && akuaS.ok);

  // ── Fixture: one POULTRY-01 item pushed below its reorder point ──
  item = await q1(
    "select * from inventory_items where business_id = 1 and min_stock_threshold > 0 order by id limit 1",
  );
  ok("fixture inventory item present", !!item);
  orig = { qty: item?.quantity, status: item?.status };
  await client.query("update inventory_items set quantity = $1, status = 'IN_STOCK' where id = $2", [
    Math.max(1, Number(item?.min_stock_threshold) - 2),
    item?.id,
  ]);

  // ── 1. Detection ──
  const g1 = await api(ownerS.cookie, "GET", "/api/low-stock?businessId=1");
  const found = (g1.data?.items || []).find((i) => i.id === item?.id);
  ok("GET /api/low-stock lists the item at/below reorder point",
    g1.status === 200 && !!found && found.severity === "LOW", `${found?.quantity} ≤ ${found?.minStockThreshold}`);
  ok("item carries name/sku/unit", !!found && !!found.sku && !!found.unit);

  // ── 2. Sweep + notification + status normalization ──
  const s1 = await api(ownerS.cookie, "POST", "/api/low-stock?businessId=1");
  ok("manager triggers the sweep", s1.status === 200 && s1.data?.success === true && s1.data?.result?.lowCount >= 1, JSON.stringify(s1.data?.result || {}));
  const row = await q1("select status from inventory_items where id = $1", [item?.id]);
  ok("item status normalized to LOW_STOCK", row?.status === "LOW_STOCK");
  const notif = await q1("select * from notifications where type = 'LOW_STOCK' and record_ref = $1 order by id desc", [recordRef]);
  ok("LOW_STOCK team notification created", !!notif);
  ok("notification is MEDIUM priority when nothing is out", notif?.priority === "MEDIUM");
  ok("notification tells the team to raise a PO", /procurement|purchase order/i.test(notif?.body || ""));

  // ── 3. Dedupe: second run same day never double-notifies ──
  const before = (await q("select id from notifications where type = 'LOW_STOCK' and record_ref = $1", [recordRef])).length;
  await api(ownerS.cookie, "POST", "/api/low-stock?businessId=1");
  const after = (await q("select id from notifications where type = 'LOW_STOCK' and record_ref = $1", [recordRef])).length;
  ok("re-running the sweep is deduped (same count)", before === after, `${before} → ${after}`);

  // ── 4. Out-of-stock escalates to HIGH ──
  await client.query("update inventory_items set quantity = 0 where id = $1", [item?.id]);
  const g2 = await api(ownerS.cookie, "GET", "/api/low-stock?businessId=1");
  const out = (g2.data?.items || []).find((i) => i.id === item?.id);
  ok("zero stock is severity OUT", out?.severity === "OUT");
  // Next day's recordRef would differ, so simulate by checking severity logic
  // on a fresh sweep: notification priority computed per run — but the same-day
  // dedupe keeps the MEDIUM row. The daily ops suite covers the next-day path.

  // ── 5. Access control ──
  const wPost = await api(akuaS.cookie, "POST", "/api/low-stock?businessId=1");
  ok("workers cannot trigger the sweep", wPost.status === 403);
  const wGet = await api(akuaS.cookie, "GET", "/api/low-stock?businessId=1");
  ok("staff in the business can read the radar", wGet.status === 200 && wGet.data?.success === true);
  const foreign = await api(akuaS.cookie, "GET", "/api/low-stock?businessId=8");
  ok("radar stays scoped to accessible businesses", foreign.status === 403);

  // ── 6. Healthy stock does not alert ──
  await client.query("update inventory_items set quantity = $1 where id = $2", [
    Number(item?.min_stock_threshold) + 50,
    item?.id,
  ]);
  const s3 = await api(ownerS.cookie, "POST", "/api/low-stock?businessId=1");
  const row3 = await q1("select status from inventory_items where id = $1", [item?.id]);
  ok("healthy stock normalizes back to IN_STOCK and does not alert",
    s3.data?.result?.lowCount === 0 && s3.data?.result?.outCount === 0 && row3?.status === "IN_STOCK");
} catch (e) {
  ok("suite ran without exception", false, String(e?.message || e));
} finally {
  if (!process.env.KEEP && item) {
    try {
      await client.query("update inventory_items set quantity = $1, status = $2 where id = $3", [orig.qty, orig.status, item.id]);
      await client.query("delete from notifications where type = 'LOW_STOCK' and record_ref = $1", [recordRef]);
      console.log("🧹 stock fixture + alerts removed");
    } catch (e) {
      console.log("⚠ cleanup issue:", e?.message);
    }
  }
  await client.end();
}

console.log(`\n${failures === 0 ? "🎉 ALL LOW-STOCK CHECKS PASSED" : `💥 ${failures} FAILING`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
