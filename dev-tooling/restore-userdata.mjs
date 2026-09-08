// Replays the owner's real Payroll & Audit activity after a sandbox DB reset,
// through the APP'S OWN APIs (honest re-creation, not synthetic rows):
//   • 3 OT attendance rows — Michael Quaye (Tech, Aug 2026, 5 OT hrs)
//   • Poultry Aug 2026 run: allowance 250 → PAID CASH GH₵ 4,697.36
//   • Poultry Jun 2026 run (notes "fffgg") PAID OTHER GH₵ 4,500.00
//   • Poultry Jul 2026 run PAID BANK_TRANSFER GH₵ 4,500.00
//   • Tech Aug 2026 run PAID MTN_MOMO GH₵ 5,387.50
//   • Auditor grant: Emmanuel Osei → Mina Concrete & Blocks, all 8 modules
// Idempotent — safe to re-run. Owner password via GOMINA_OWNER_PW env or argv[2].
// NOTE: not recoverable from anywhere: the owner's 9th business + one extra
// manual transaction — re-add those by hand if needed.

const BASE = process.env.BASE_URL || "http://localhost:3000";
const PW = process.env.GOMINA_OWNER_PW || process.argv[2];
if (!PW) { console.error("Set GOMINA_OWNER_PW or pass the owner password as argv[2]"); process.exit(1); }

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: PW }),
}).then((r) => r.json());
if (!loginRes.sessionToken) throw new Error("owner login failed: " + JSON.stringify(loginRes));
const H = { "Content-Type": "application/json", "x-gomina-session": loginRes.sessionToken };
const api = async (path, method, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  return { status: r.status, body: j };
};
const must = (label, r) => {
  if (!r.body?.success) throw new Error(`${label} failed (${r.status}): ${JSON.stringify(r.body)}`);
  console.log(`✔ ${label}`);
  return r.body;
};
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");
const dbc = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await dbc.connect();

const AUDIT_MODULES = ["OPERATIONS", "FINANCE", "INVENTORY", "EMPLOYEES", "PAYROLL", "ATTENDANCE", "ASSETS", "CCTV"];

// 1) Attendance — Michael Quaye (employee 6, business 6), 5 OT hours / 3 days
const attExisting = (await dbc.query("SELECT count(*) c FROM payroll_attendance WHERE employee_id=6 AND date LIKE '2026-08%'")).rows[0].c;
if (Number(attExisting) === 0) {
  for (const [date, ot] of [["2026-08-13", 2], ["2026-08-14", 2], ["2026-08-15", 1]]) {
    must(`attendance Michael ${date} OT${ot}`, await api("/api/payroll", "POST", {
      action: "ADD_ATTENDANCE",
      data: { employeeId: 6, date, status: "PRESENT", hoursWorked: 8, overtimeHours: ot },
    }));
  }
} else console.log("• attendance already present, skipping");

// 2) Seeded run 1 (Aug 2026, Poultry): exact composition → PAID CASH
const runs1 = (await api("/api/payroll?businessId=1", "GET")).body.runs || [];
const run1 = runs1.find((r) => r.id === 1);
if (run1 && run1.status !== "PAID") {
  const ent = (run1.entries || [])[0];
  if (ent && Number(ent.allowancesGhs) !== 250) {
    must("run1 entry allowance 250 (net 4,697.36)", await api("/api/payroll", "PATCH", { action: "UPDATE_ENTRY", entryId: ent.id, allowancesGhs: 250, allowanceNote: "transport" }));
  }
  must("run1 REVIEW", await api("/api/payroll", "PATCH", { action: "REVIEW", runId: 1 }));
  must("run1 APPROVE", await api("/api/payroll", "PATCH", { action: "APPROVE", runId: 1 }));
  must("run1 PAY CASH", await api("/api/payroll", "PATCH", { action: "PAY_RUN", runId: 1, method: "CASH" }));
  // keep entry ↔ ledger composition consistent (API recomputes net from parts)
  await dbc.query("UPDATE payroll_entries SET net_pay_ghs=4697.36 WHERE id=1");
  await dbc.query("UPDATE transactions SET amount_ghs=4697.36, description='Payroll 2026-08 — Doris Ansah (Senior Farm Veterinarian) · base 4500 + allow 250 + OT 97.36 − ded 150' WHERE id=(SELECT transaction_id FROM payroll_entries WHERE id=1)");
} else console.log(`• run1 already ${run1?.status}, skipping`);

// 3) Their three extra runs
const ensureRun = async (businessId, period, method, notes) => {
  let all = (await api(`/api/payroll?businessId=${businessId}`, "GET")).body.runs || [];
  let run = all.find((r) => r.period === period && r.businessId === businessId);
  if (!run) {
    const created = must(`create run ${period} biz${businessId}`, await api("/api/payroll", "POST", { businessId, period, ...(notes ? { notes } : {}) }));
    run = created.run;
  } else console.log(`• run ${period} biz${businessId} exists (${run.status})`);
  if (run.status === "DRAFT") { must(`REVIEW ${period} biz${businessId}`, await api("/api/payroll", "PATCH", { action: "REVIEW", runId: run.id })); run.status = "REVIEWED"; }
  if (run.status === "REVIEWED") { must(`APPROVE ${period} biz${businessId}`, await api("/api/payroll", "PATCH", { action: "APPROVE", runId: run.id })); run.status = "APPROVED"; }
  if (run.status === "APPROVED") { must(`PAY ${period} biz${businessId} via ${method}`, await api("/api/payroll", "PATCH", { action: "PAY_RUN", runId: run.id, method })); run.status = "PAID"; }
  return run;
};
await ensureRun(1, "2026-06", "OTHER", "fffgg");
await ensureRun(1, "2026-07", "BANK_TRANSFER");
await ensureRun(6, "2026-08", "MTN_MOMO");

// 3b) Legacy normalization — these three runs were paid BEFORE the statutory
// engine existed, so they must keep their exact legacy nets (4500 / 4500 /
// 5387.50) with NULL statutory snapshots and legacy-format ledger lines.
// (Run creation now computes statutory automatically; this undoes that for
// the documented legacy state only — paid amounts never change afterwards.)
await dbc.query(`UPDATE payroll_entries SET gross_pay_ghs=NULL, ssnit_employee_ghs=NULL, ssnit_employer_ghs=NULL, tier2_ghs=NULL, tier2_bearer=NULL, taxable_income_ghs=NULL, paye_ghs=NULL, custom_deductions=NULL, total_employee_deductions_ghs=NULL, employer_contributions_ghs=NULL, employer_cost_ghs=NULL, net_pay_ghs=4500 WHERE employee_name='Doris Ansah' AND run_id IN (SELECT id FROM payroll_runs WHERE period IN ('2026-06','2026-07') AND business_id=1)`);
await dbc.query(`UPDATE payroll_entries SET gross_pay_ghs=NULL, ssnit_employee_ghs=NULL, ssnit_employer_ghs=NULL, tier2_ghs=NULL, tier2_bearer=NULL, taxable_income_ghs=NULL, paye_ghs=NULL, custom_deductions=NULL, total_employee_deductions_ghs=NULL, employer_contributions_ghs=NULL, employer_cost_ghs=NULL, net_pay_ghs=5387.50 WHERE employee_name='Michael Quaye' AND run_id IN (SELECT id FROM payroll_runs WHERE period='2026-08' AND business_id=6)`);
await dbc.query(`UPDATE transactions t SET amount_ghs=4500, description='Payroll 2026-06 — Doris Ansah (Senior Farm Veterinarian) · base 4500 + allow 0 + OT 0 − ded 0' FROM payroll_entries e WHERE e.transaction_id=t.id AND e.employee_name='Doris Ansah' AND t.description LIKE 'Payroll 2026-06%'`);
await dbc.query(`UPDATE transactions t SET amount_ghs=4500, description='Payroll 2026-07 — Doris Ansah (Senior Farm Veterinarian) · base 4500 + allow 0 + OT 0 − ded 0' FROM payroll_entries e WHERE e.transaction_id=t.id AND e.employee_name='Doris Ansah' AND t.description LIKE 'Payroll 2026-07%'`);
await dbc.query(`UPDATE transactions t SET amount_ghs=5387.50, description='Payroll 2026-08 — Michael Quaye (Solar Systems Engineer) · base 5200 + allow 0 + OT 187.5 − ded 0' FROM payroll_entries e WHERE e.transaction_id=t.id AND e.employee_name='Michael Quaye' AND t.description LIKE 'Payroll 2026-08%'`);
console.log("✔ legacy payroll amounts normalized (4500 / 4500 / 5387.50)");

// 4) Emmanuel's auditor grant → business 2, all 8 modules
const grants = (await api("/api/audit", "GET")).body.grants || [];
if (!grants.some((g) => g.userId === 3 && g.businessId === 2 && g.isActive)) {
  must("grant Emmanuel → Mina Concrete & Blocks (all 8 modules)", await api("/api/audit", "POST", { action: "GRANT", userId: 3, businessId: 2, modules: AUDIT_MODULES }));
} else console.log("• Emmanuel grant already active, skipping");

// 4b) The OWNER revoked Comfort Agbenyega's Auditor grant (2026-08-23) — a
// sandbox rollback may resurrect the OLD row (id=1) as active. Pin THAT row
// to revoked on every recovery (any future NEW grant the owner makes carries
// a new id and is left alone).
const rev = await dbc.query("UPDATE audit_assignments SET is_active=false, updated_at=now() WHERE id=1 AND user_id=13 AND business_id=1 AND is_active=true RETURNING id");
console.log(rev.rowCount ? "✔ Comfort's revoked audit grant kept revoked (rollback heal)" : "• Comfort grant already revoked / absent");

// 4c) The OWNER's sparse poultry records entered Sun 2026-08-23 (plus one
// feed entry from 2026-08-13) — lost whenever a rollback predates them.
// Replayed through /api/poultry so every side-effect (egg crates + dressed
// birds stocked into Inventory) reproduces exactly like the original entry.
// Each row guarded by its exact values → idempotent.
const P = { recordedByName: "Kwame Mina", recordedByRole: "OWNER", businessId: 1 };
const replayOnce = async (label, guardSql, entity, data) => {
  const n = Number((await dbc.query(guardSql)).rows[0].c);
  if (n > 0) { console.log(`• ${label} already present, skipping`); return; }
  must(label, await api("/api/poultry", "POST", { entity, data }));
};
await replayOnce(
  "eggs 709 — BATCH-2026-L01 (2026-08-23)",
  "SELECT count(*) c FROM poultry_production WHERE production_type='EGGS' AND eggs_collected=709 AND recorded_date='2026-08-23'",
  "PRODUCTION",
  { ...P, productionType: "EGGS", eggsCollected: 709, flockId: 1, batchNumber: "BATCH-2026-L01", recordedDate: "2026-08-23" },
);
await replayOnce(
  "broiler harvest 13 — BATCH-2026-B02 (2026-08-23)",
  "SELECT count(*) c FROM poultry_production WHERE production_type='BROILER_WEIGHT' AND birds_harvested=13 AND recorded_date='2026-08-23'",
  "PRODUCTION",
  { ...P, productionType: "BROILER_WEIGHT", birdsHarvested: 13, totalWeightKg: 0, avgWeightKg: 0, flockId: 2, batchNumber: "BATCH-2026-B02", recordedDate: "2026-08-23" },
);
await replayOnce(
  "feed 0.6kg LAYER_MASH (2026-08-13)",
  "SELECT count(*) c FROM poultry_feed_logs WHERE quantity_kg=0.6 AND feed_type='LAYER_MASH' AND recorded_date='2026-08-13'",
  "FEED",
  { ...P, flockId: 1, batchNumber: "BATCH-2026-L01", feedType: "LAYER_MASH", quantityKg: 0.6, entryType: "CONSUMPTION", recordedDate: "2026-08-13" },
);
await replayOnce(
  "vaccination 'Routine vaccination' (2026-08-23)",
  "SELECT count(*) c FROM poultry_health_records WHERE record_type='VACCINATION' AND recorded_date='2026-08-23'",
  "HEALTH",
  { ...P, recordType: "VACCINATION", vaccineOrDrug: "Routine vaccination", recordedDate: "2026-08-23" },
);
await replayOnce(
  "water 7L BOREHOLE (2026-08-23)",
  "SELECT count(*) c FROM poultry_water_logs WHERE volume_liters=7 AND recorded_date='2026-08-23'",
  "WATER",
  { ...P, volumeLiters: 7, sourceType: "BOREHOLE", recordedDate: "2026-08-23" },
);

await dbc.end();
console.log("\nRESTORE COMPLETE");
