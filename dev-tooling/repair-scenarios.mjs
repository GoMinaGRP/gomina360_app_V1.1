/** repair-scenarios.mjs — one-off data repair (run once, idempotent):
 *  1. DELETE the exact duplicate scenario row (owner double-submit).
 *  2. Recompute every stored simulation's projected impacts with the REAL
 *     scenario engine (they were written by the old hardcoded math).
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");
const BASE = "http://127.0.0.1:3000";
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await pg.connect();

const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" }) });
const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
if (!res.ok) { console.error("login failed"); process.exit(1); }

// 1. de-duplicate: keep the EARLIEST row of each identical fingerprint
const dups = await pg.query(`
  DELETE FROM scenario_simulations a USING scenario_simulations b
  WHERE a.id > b.id
    AND a.name = b.name AND a.variable_changed = b.variable_changed
    AND a.percent_change = b.percent_change
    AND COALESCE(a.target_business_id,-1) = COALESCE(b.target_business_id,-1)
  RETURNING a.id`);
console.log(`deleted ${dups.rowCount} duplicate scenario row(s):`, dups.rows.map(r => r.id));

// 2. recompute impacts through the live engine
const rows = (await pg.query(`SELECT id, variable_changed v, percent_change p, target_business_id t FROM scenario_simulations ORDER BY id`)).rows;
for (const r of rows) {
  const qs = new URLSearchParams({ variable: r.v, pct: String(r.p) });
  if (r.t) qs.set("businessId", String(r.t));
  const sim = await (await fetch(`${BASE}/api/scenarios/simulate?${qs}`, { headers: { Cookie: cookie } })).json();
  if (!sim.success) { console.error(`row ${r.id}: simulate failed`, sim); continue; }
  await pg.query(
    `UPDATE scenario_simulations SET expected_revenue_impact_ghs=$2, expected_profit_impact_ghs=$3, expected_roi_delta=$4 WHERE id=$1`,
    [r.id, sim.impacts.revenueImpact, sim.impacts.profitImpact, sim.impacts.roiDelta]);
  console.log(`row ${r.id} (${r.v} ${r.p}%, biz ${r.t ?? "ALL"}): rev ${sim.impacts.revenueImpact} · prof ${sim.impacts.profitImpact} · roi ${sim.impacts.roiDelta} — ${sim.impacts.basis}`);
}
await pg.end();
console.log("repair complete");
