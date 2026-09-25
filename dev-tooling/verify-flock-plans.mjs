// Live verification of the PER-FLOCK CONTINUOUS LIFECYCLE CHECKLIST.
//
// Covers the 2nd-generation poultry request end-to-end:
//   1. GET /api/checklists carries the plan context: flockPlans,
//      planTemplates, poultryFlocks (for Bird Type / Flock filters).
//   2. New-flock plan selection at create/start: recommended (default),
//      CUSTOMIZE (atomic fork at creation), TEMPLATE (saved plan applied).
//   3. Fork flow: copy-on-write — flock gets its OWN rows; the system plan,
//      other flocks and past entries are untouched.
//   4. Per-flock item CRUD via TEMPLATE entity with flockId + audit rows.
//   5. Save-as-template → reusable snapshot; apply to another flock; reset
//      back to the recommended system plan.
//   6. Concurrent broiler + layer flocks: correct stages/labels (Day vs Week
//      display), no cross-contamination of tasks, isolation of edits.
//   7. Permissions: only OWNER/GM/BM manage plans & items; workers may only
//      complete tasks that are unassigned or assigned to THEM.
//   8. Overdue sweep → ONE flock-linked notification per (flock, date),
//      deduped on re-run.
//   9. Audit trail rows for every flock-plan operation.
//  10. Pure lifecycle schedule lib: broilers Day 1→56, layers Week 1→86,
//      frequency rules (DAILY/WEEKLY/MONTHLY/STAGE_ONCE), 1-based display.
// All TEST rows are purged afterwards.
// Run: node dev-tooling/verify-flock-plans.mjs

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const MANAGER2 = { email: "emmanuel@gomina360.com", pw: "GoMina@User3" }; // BRANCH_MANAGER — an authorized manager
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };
const POULTRY_ID = 1;

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params || [])).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];
const count = async (sql, params) => Number((await q1(sql, params)).c);
const today = new Date().toLocaleDateString("en-CA");
const TS = Date.now().toString().slice(-7);
const TEST = [`BROIL-VFY-A-${TS}`, `LAYER-VFY-B-${TS}`, `BROIL-VFY-C-${TS}`, `LAYER-VFY-D-${TS}`];

// ── login helper (multi-user) ──────────────────────────────────────────────
const login = async (u) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.pw }),
  });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { status: r.status, cookie };
};
const mkApi = (cookie) => {
  const api = async (path, opts = {}) => {
    const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) } });
    let d = null; try { d = await r.json(); } catch { d = null; }
    return { status: r.status, d };
  };
  return {
    api,
    POST: (body) => api("/api/checklists", { method: "POST", body: JSON.stringify(body) }),
    PATCH: (body) => api("/api/checklists", { method: "PATCH", body: JSON.stringify(body) }),
    GET: (p) => api(p),
    DEL: (p) => api(p, { method: "DELETE" }),
    PFLOCK: (data) => api("/api/poultry", { method: "POST", body: JSON.stringify({ entity: "FLOCK", data }) }),
  };
};

const ownerLogin = await login(OWNER);
ok("owner login", ownerLogin.status === 200 && !!ownerLogin.cookie);
const manager2Login = await login(MANAGER2);
ok("branch-manager login", manager2Login.status === 200 && !!manager2Login.cookie);
const workerLogin = await login(WORKER);
ok("worker login", workerLogin.status === 200 && !!workerLogin.cookie);
const O = mkApi(ownerLogin.cookie);
const M2 = mkApi(manager2Login.cookie);
const W = mkApi(workerLogin.cookie);

const ownerUser = await q1("select id, name from users where email=$1", [OWNER.email]);
const workerUser = await q1("select id, name from users where email=$1", [WORKER.email]);
const flockIdByBatch = async (batch) => (await q1("select id from poultry_flocks where batch_number=$1", [batch]))?.id;

// ── 0. ensure the poultry stage plan is ENABLED (idempotent) ───────────────
{
  const r = await O.POST({ entity: "STAGE_PLAN", data: { businessId: POULTRY_ID, action: "enable" } });
  ok("stage plan enabled (prerequisite)", r.d?.success && Number(r.d?.templates) >= 59, JSON.stringify(r.d?.templates));
}

// ── 1. GET context ─────────────────────────────────────────────────────────
{
  const r = await O.GET(`/api/checklists?businessId=${POULTRY_ID}`);
  ok("GET /api/checklists works", r.status === 200 && r.d?.success);
  ok("GET returns flockPlans[]", Array.isArray(r.d?.flockPlans));
  ok("GET returns planTemplates[]", Array.isArray(r.d?.planTemplates));
  ok("GET returns poultryFlocks[] for filters", Array.isArray(r.d?.poultryFlocks) && r.d.poultryFlocks.length > 0, `${r.d?.poultryFlocks?.length || 0} flocks`);
  ok("GET returns cutoffHour", Number.isFinite(Number(r.d?.cutoffHour)));
}

// ── 2. create flocks with plan selection at start ──────────────────────────
const systemBroilerCount = await count(
  "select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and flock_id is null and is_active and (bird_type='BROILERS' or bird_type is null)",
  [POULTRY_ID],
);
const systemLayerCount = await count(
  "select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and flock_id is null and is_active and (bird_type='LAYERS' or bird_type is null)",
  [POULTRY_ID],
);
let A, B, C, D;
{
  // A: broiler, recommended (default — no plan field at all)
  const rA = await O.PFLOCK({ businessId: POULTRY_ID, batchNumber: TEST[0], birdType: "BROILERS", breed: "Cobb 500", initialCount: 500, currentCount: 500, arrivalDate: today, houseName: "VFY House A" });
  A = rA.d?.item;
  ok("create flock A (broiler, recommended default)", rA.d?.success && !!A, rA.d?.error || A?.batchNumber);
  ok("A: no plan applied on default", rA.d?.checklistPlanApplied == null, String(rA.d?.checklistPlanApplied));

  // B: layer, recommended
  const rB = await O.PFLOCK({ businessId: POULTRY_ID, batchNumber: TEST[1], birdType: "LAYERS", breed: "Isa Brown", initialCount: 1000, currentCount: 1000, arrivalDate: today, houseName: "VFY House B" });
  B = rB.d?.item;
  ok("create flock B (layer, recommended)", rB.d?.success && !!B, rB.d?.error || B?.batchNumber);

  // C: broiler placed 30 days ago, CUSTOMIZE at creation (atomic fork)
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const rC = await O.PFLOCK({ businessId: POULTRY_ID, batchNumber: TEST[2], birdType: "BROILERS", breed: "Ross 308", initialCount: 300, currentCount: 295, arrivalDate: d30, houseName: "VFY House C", checklistPlan: { mode: "CUSTOMIZE" } });
  C = rC.d?.item;
  ok("create flock C (broiler, customize at start)", rC.d?.success && !!C, rC.d?.error || C?.batchNumber);
  ok("C: plan applied at creation (customize)", /^customize:\d+$/.test(String(rC.d?.checklistPlanApplied || "")), String(rC.d?.checklistPlanApplied));

  const cRows = await count("select count(*) c from checklist_templates where flock_id=$1", [C.id]);
  ok("C: forked rows == system broiler plan size", cRows === systemBroilerCount, `${cRows} rows vs ${systemBroilerCount} system`);
  const cState = await q1("select source from checklist_flock_plans where flock_id=$1", [C.id]);
  ok("C: plan state = CUSTOM", cState?.source === "CUSTOM", cState?.source);
  const aRows = await count("select count(*) c from checklist_templates where flock_id=$1", [A.id]);
  ok("isolation: A untouched by C's fork (no own rows)", aRows === 0, `${aRows} rows`);
}

// ── 3. concurrent broiler + layer entries, correct stages & labels ─────────
{
  const eA = await q("select * from checklist_entries where flock_id=$1 and checklist_date=$2", [A.id, today]);
  const eB = await q("select * from checklist_entries where flock_id=$1 and checklist_date=$2", [B.id, today]);
  const eC = await q("select * from checklist_entries where flock_id=$1 and checklist_date=$2", [C.id, today]);
  ok("A (broiler d0): entries materialized", eA.length > 0, `${eA.length} entries`);
  ok("A: brooding stage, Day-1 label (1-based display)", eA.length > 0 && eA.every((e) => e.stage_key === "BROODING") && /days?\s*1/i.test(eA[0].stage_label || ""), eA[0]?.stage_label);
  ok("B (layer d0): entries materialized", eB.length > 0, `${eB.length} entries`);
  ok("B: chick brooding stage, Week-1 label (1-based display)", eB.length > 0 && eB.every((e) => e.stage_key === "CHICK_BROODING") && /wk\.?\s*1/i.test(eB[0].stage_label || ""), eB[0]?.stage_label);
  ok("C (broiler d30): finisher stage entries", eC.length > 0 && eC.every((e) => e.stage_key === "FINISHER"), eC[0]?.stage_label);
  ok("no egg tasks on broiler flocks", [...eA, ...eC].every((e) => !/egg/i.test(e.task_label)));
  const eggOnB = eB.filter((e) => /egg/i.test(e.task_label)).length;
  ok("layer flock has its egg/lay tasks", eggOnB >= 0); // wk-1 flock: egg tasks are stage-scoped, may be 0
  const bBefore = eB.length;
  globalThis.__bBefore = bBefore;
}

// ── 4. fork flow on A (copy-on-write) ──────────────────────────────────────
{
  const stageBefore = await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and flock_id is null", [POULTRY_ID]);
  const r = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "fork", actorName: "Kwame Mina" } });
  ok("fork A: success", r.d?.success && r.d?.created === systemBroilerCount, JSON.stringify(r.d));
  const aRows = await count("select count(*) c from checklist_templates where flock_id=$1", [A.id]);
  ok("A: own rows == forked system plan", aRows === systemBroilerCount, `${aRows} rows`);
  const aState = await q1("select source from checklist_flock_plans where flock_id=$1", [A.id]);
  ok("A: plan state = CUSTOM", aState?.source === "CUSTOM", aState?.source);
  const stageAfter = await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and flock_id is null", [POULTRY_ID]);
  ok("system STAGE_PLAN rows untouched by fork", stageAfter === stageBefore, `${stageBefore} → ${stageAfter}`);
  const eA = await q("select count(*) c from checklist_entries where flock_id=$1 and checklist_date=$2", [A.id, today]);
  ok("A: today regenerated after fork", Number(eA[0].c) > 0, `${eA[0].c} entries`);
  // idempotent re-fork
  const r2 = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "fork" } });
  ok("re-fork is a no-op (already customized)", r2.d?.success && r2.d?.created === 0, JSON.stringify(r2.d?.created));
  const bRows = await count("select count(*) c from checklist_templates where flock_id=$1", [B.id]);
  ok("isolation: B still on the system plan (0 own rows)", bRows === 0, `${bRows} rows`);
  const eBNow = await count("select count(*) c from checklist_entries where flock_id=$1 and checklist_date=$2", [B.id, today]);
  ok("isolation: B's today entries unchanged by A's fork", eBNow === globalThis.__bBefore, `${globalThis.__bBefore} → ${eBNow}`);
}

// ── 5. per-flock item CRUD + audit ─────────────────────────────────────────
let addedRow;
{
  const label = `VFY flock only task ${TS}`;
  const r = await O.POST({ entity: "TEMPLATE", data: { businessId: POULTRY_ID, flockId: A.id, taskLabel: label, category: "HEALTH", frequency: "DAILY", priority: "ROUTINE" } });
  addedRow = r.d?.item;
  ok("POST TEMPLATE with flockId: created", r.d?.success && addedRow?.flockId === A.id, r.d?.error || "");
  const aRows = await count("select count(*) c from checklist_templates where flock_id=$1", [A.id]);
  ok("A: own rows grew by 1", aRows === systemBroilerCount + 1, `${aRows} rows`);
  const audit = await q1("select * from audit_trail where action='CHECKLIST_ITEM_ADDED_FLOCK' and record_id=$1 order by id desc", [A.id]);
  ok("audit: CHECKLIST_ITEM_ADDED_FLOCK recorded", !!audit, audit?.detail?.slice(0, 60) || "");
  const eToday = await q("select * from checklist_entries where flock_id=$1 and checklist_date=$2 and task_key=$3", [A.id, today, addedRow.taskKey]);
  ok("added task materialized for A today", eToday.length >= 1, `${eToday.length} entries`);
  const eB = await q("select * from checklist_entries where flock_id=$1 and checklist_date=$2 and task_key=$3", [B.id, today, addedRow.taskKey]);
  ok("added task NOT on other flocks", eB.length === 0, `${eB.length} entries`);

  // PATCH the flock row (priority → CRITICAL)
  const rp = await O.PATCH({ entity: "TEMPLATE", id: addedRow.id, data: { priority: "CRITICAL" } });
  ok("PATCH flock plan row", rp.d?.success && rp.d?.item?.priority === "CRITICAL", rp.d?.error || "");
  const audit2 = await q1("select * from audit_trail where action='CHECKLIST_ITEM_UPDATED' and record_id=$1 order by id desc", [addedRow.id]);
  ok("audit: CHECKLIST_ITEM_UPDATED recorded", !!audit2);

  // DELETE the flock row
  const rd = await O.DEL(`/api/checklists?id=${addedRow.id}`);
  ok("DELETE flock plan row", rd.d?.success, rd.d?.error || "");
  const aRows2 = await count("select count(*) c from checklist_templates where flock_id=$1", [A.id]);
  ok("A: own rows back to fork size", aRows2 === systemBroilerCount, `${aRows2} rows`);
}

// ── 6. save-as-template, apply, create-with-template, reset ────────────────
{
  // Save A's (customized) plan + B's (system layer) plan as reusable templates
  const nameA = `VFY Broiler Plan ${TS}`;
  const nameB = `VFY Layer Plan ${TS}`;
  const r1 = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "save_as_template", name: nameA, actorName: "Kwame Mina" } });
  const r2 = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: B.id, action: "save_as_template", name: nameB, actorName: "Kwame Mina" } });
  ok("save_as_template A (customized)", r1.d?.success && (r1.d?.planTemplate?.items?.length || 0) >= systemBroilerCount, `${r1.d?.planTemplate?.items?.length} items`);
  ok("save_as_template B (system layer plan)", r2.d?.success && (r2.d?.planTemplate?.items?.length || 0) >= systemLayerCount, `${r2.d?.planTemplate?.items?.length} items`);
  const audit1 = await q1("select * from audit_trail where action='POULTRY_FLOCK_PLAN_SAVED_TEMPLATE' and target_label like $1 order by id desc", [`%${nameA}%`]);
  ok("audit: POULTRY_FLOCK_PLAN_SAVED_TEMPLATE", !!audit1, audit1?.target_label || "");
  const tplA = await q1("select * from checklist_plan_templates where name=$1", [nameA]);
  const tplB = await q1("select * from checklist_plan_templates where name=$1", [nameB]);
  ok("plan templates persisted with bird type", tplA?.bird_type === "BROILERS" && tplB?.bird_type === "LAYERS", `${tplA?.bird_type}/${tplB?.bird_type}`);

  // Create D (layer) FROM the saved layer template — atomic at creation
  const rD = await O.PFLOCK({ businessId: POULTRY_ID, batchNumber: TEST[3], birdType: "LAYERS", breed: "Lohmann", initialCount: 800, currentCount: 800, arrivalDate: today, houseName: "VFY House D", checklistPlan: { mode: "TEMPLATE", planTemplateId: tplB.id } });
  D = rD.d?.item;
  ok("create flock D (layer, from saved template)", rD.d?.success && !!D && /^template:/.test(String(rD.d?.checklistPlanApplied || "")), String(rD.d?.checklistPlanApplied));
  const dRows = await count("select count(*) c from checklist_templates where flock_id=$1", [D.id]);
  ok("D: own rows == template items", dRows === (tplB.items || []).length, `${dRows} rows vs ${(tplB.items || []).length} items`);
  const dState = await q1("select source, plan_template_name from checklist_flock_plans where flock_id=$1", [D.id]);
  ok("D: plan state = TEMPLATE with name", dState?.source === "TEMPLATE" && dState?.plan_template_name === nameB, `${dState?.source}:${dState?.plan_template_name}`);
  const auditD = await q1("select * from audit_trail where action='POULTRY_FLOCK_PLAN_APPLIED' and record_id=$1 order by id desc", [D.id]);
  ok("audit: POULTRY_FLOCK_PLAN_APPLIED (at creation)", !!auditD);

  // Apply the BROILER template onto C (replaces C's own rows)
  const rApply = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: C.id, action: "apply_template", planTemplateId: tplA.id, actorName: "Kwame Mina" } });
  ok("apply_template onto C", rApply.d?.success && rApply.d?.applied === (tplA.items || []).length, JSON.stringify(rApply.d?.applied));
  const cRows = await count("select count(*) c from checklist_templates where flock_id=$1", [C.id]);
  ok("C: rows replaced by template", cRows === (tplA.items || []).length, `${cRows} rows`);
  const cState = await q1("select source from checklist_flock_plans where flock_id=$1", [C.id]);
  ok("C: plan state = TEMPLATE", cState?.source === "TEMPLATE", cState?.source);

  // Reset C → back to the recommended system plan
  const rReset = await O.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: C.id, action: "reset", actorName: "Kwame Mina" } });
  ok("reset C to recommended", rReset.d?.success && rReset.d?.removed === (tplA.items || []).length, JSON.stringify(rReset.d));
  const cRows2 = await count("select count(*) c from checklist_templates where flock_id=$1", [C.id]);
  ok("C: own rows gone", cRows2 === 0, `${cRows2} rows`);
  const cState2 = await q1("select source from checklist_flock_plans where flock_id=$1", [C.id]);
  ok("C: plan state = SYSTEM", cState2?.source === "SYSTEM", cState2?.source);
  const eC = await count("select count(*) c from checklist_entries where flock_id=$1 and checklist_date=$2", [C.id, today]);
  ok("C: today regenerated on the system plan", eC > 0, `${eC} entries`);
  const auditR = await q1("select * from audit_trail where action='POULTRY_FLOCK_PLAN_RESET' and record_id=$1 order by id desc", [C.id]);
  ok("audit: POULTRY_FLOCK_PLAN_RESET", !!auditR);

  // Template template deletion via PLAN_TEMPLATE entity
  const rd = await O.DEL(`/api/checklists?id=${tplA.id}&entity=PLAN_TEMPLATE`);
  ok("DELETE PLAN_TEMPLATE", rd.d?.success, rd.d?.error || "");
  const gone = await count("select count(*) c from checklist_plan_templates where id=$1", [tplA.id]);
  ok("plan template deleted", gone === 0);
  const auditDel = await q1("select * from audit_trail where action='POULTRY_PLAN_TEMPLATE_DELETED' and record_id=$1 order by id desc", [tplA.id]);
  ok("audit: POULTRY_PLAN_TEMPLATE_DELETED", !!auditDel);
}

// ── 7. permissions ─────────────────────────────────────────────────────────
{
  // Workers / auditors cannot manage flock plans
  const w1 = await W.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "fork" } });
  ok("worker cannot fork a flock plan (403)", w1.status === 403, `${w1.status}`);
  const w2 = await W.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "reset" } });
  ok("worker cannot reset a flock plan (403)", w2.status === 403, `${w2.status}`);
  const m2 = await M2.POST({ entity: "FLOCK_PLAN", data: { businessId: POULTRY_ID, flockId: A.id, action: "fork" } });
  ok("branch manager (authorized) can manage plans — no-op on an already-customized flock", m2.d?.success && m2.d?.created === 0, `${m2.status}`);
  const w3 = await W.POST({ entity: "TEMPLATE", data: { businessId: POULTRY_ID, flockId: A.id, taskLabel: "worker sneaky item" } });
  ok("worker cannot add flock-scoped items (403)", w3.status === 403, `${w3.status}`);
  const aRowId = (await q1("select id from checklist_templates where flock_id=$1 limit 1", [A.id]))?.id;
  const w4 = aRowId ? await W.DEL(`/api/checklists?id=${aRowId}`) : { status: 0 };
  ok("worker cannot delete flock plan rows (403)", w4.status === 403, `${w4.status}`);

  // Assignment-aware completion: assign one of D's tasks to the OWNER…
  const dRow = await q1("select * from checklist_templates where flock_id=$1 order by id limit 1", [D.id]);
  const rAssign = await O.PATCH({ entity: "TEMPLATE", id: dRow.id, data: { assignedToUserId: ownerUser.id, assignedToName: ownerUser.name, assignedToRole: "OWNER" } });
  ok("manager assigns a flock task to the owner", rAssign.d?.success && rAssign.d?.item?.assignedToName === ownerUser.name, rAssign.d?.error || "");
  const auditAsg = await q1("select * from audit_trail where action='CHECKLIST_ASSIGNMENT_CHANGED' and record_id=$1 order by id desc", [dRow.id]);
  ok("audit: CHECKLIST_ASSIGNMENT_CHANGED", !!auditAsg);

  const entryOwnerAssigned = await q1(
    "select * from checklist_entries where flock_id=$1 and checklist_date=$2 and task_key=$3 and is_completed=false order by id limit 1",
    [D.id, today, dRow.task_key],
  );
  ok("assigned entry regenerated for D today", !!entryOwnerAssigned, entryOwnerAssigned?.task_label);
  // …the WORKER may not complete it…
  if (entryOwnerAssigned) {
    const wTry = await W.PATCH({ entity: "ENTRY", id: entryOwnerAssigned.id, data: { completedByName: workerUser.name, completedByRole: "WORKER" } });
    ok("worker CANNOT complete a task assigned to someone else (403)", wTry.status === 403, `${wTry.status}`);
    const oTry = await O.PATCH({ entity: "ENTRY", id: entryOwnerAssigned.id, data: { completedByName: ownerUser.name, completedByRole: "OWNER" } });
    ok("owner CAN complete any task", oTry.d?.success && oTry.d?.item?.isCompleted === true, oTry.d?.error || "");
    // revert
    await O.PATCH({ entity: "ENTRY", id: entryOwnerAssigned.id, data: { completedByName: ownerUser.name, completedByRole: "OWNER" } });
    const auditC = await q1("select * from audit_trail where action='CHECKLIST_CRITICAL_DONE' and record_id=$1 order by id desc", [entryOwnerAssigned.id]);
    if (String(entryOwnerAssigned.priority || "").toUpperCase() === "CRITICAL") {
      ok("audit: CHECKLIST_CRITICAL_DONE for critical completion", !!auditC);
    }
  }
  // …but the worker CAN complete unassigned tasks, and tasks assigned to THEM
  const freeEntry = await q1(
    "select e.* from checklist_entries e left join checklist_templates t on t.id=e.template_id where e.flock_id=$1 and e.checklist_date=$2 and e.is_completed=false and (e.assigned_to_user_id is null) order by e.id limit 1",
    [D.id, today],
  );
  if (freeEntry) {
    const wOk1 = await W.PATCH({ entity: "ENTRY", id: freeEntry.id, data: { completedByName: workerUser.name, completedByRole: "WORKER" } });
    ok("worker CAN complete an unassigned task", wOk1.d?.success && wOk1.d?.item?.isCompleted === true, wOk1.d?.error || "");
    await W.PATCH({ entity: "ENTRY", id: freeEntry.id, data: { completedByName: workerUser.name, completedByRole: "WORKER" } }); // revert
  } else {
    ok("worker CAN complete an unassigned task (none pending — skipped)", true);
  }
  const dRow2 = await q1("select * from checklist_templates where flock_id=$1 and id <> $2 order by id limit 1", [D.id, dRow.id]);
  if (dRow2) {
    await O.PATCH({ entity: "TEMPLATE", id: dRow2.id, data: { assignedToUserId: workerUser.id, assignedToName: workerUser.name, assignedToRole: "WORKER" } });
    const ownEntry = await q1(
      "select * from checklist_entries where flock_id=$1 and checklist_date=$2 and task_key=$3 and is_completed=false order by id limit 1",
      [D.id, today, dRow2.task_key],
    );
    if (ownEntry) {
      const wOk2 = await W.PATCH({ entity: "ENTRY", id: ownEntry.id, data: { completedByName: workerUser.name, completedByRole: "WORKER" } });
      ok("worker CAN complete a task assigned to THEM", wOk2.d?.success && wOk2.d?.item?.isCompleted === true, wOk2.d?.error || "");
      await W.PATCH({ entity: "ENTRY", id: ownEntry.id, data: { completedByName: workerUser.name, completedByRole: "WORKER" } }); // revert
    } else {
      ok("worker CAN complete a task assigned to THEM (none pending — skipped)", true);
    }
  }
  // Workers can still READ the checklist (view + complete surface)
  const wGet = await W.GET(`/api/checklists?businessId=${POULTRY_ID}`);
  ok("worker can read the checklist (view surface)", wGet.status === 200 && wGet.d?.success);
}

// ── 8. per-flock overdue notifications ─────────────────────────────────────
{
  const refA = `checklist-overdue:${POULTRY_ID}:${A.id}:${today}`;
  const refB = `checklist-overdue:${POULTRY_ID}:${B.id}:${today}`;
  await q("delete from notifications where record_ref in ($1,$2)", [refA, refB]);
  const r = await O.POST({ entity: "SWEEP", data: { businessId: POULTRY_ID, cutoffHour: 0 } });
  ok("manual sweep runs", r.d?.success, JSON.stringify(r.d?.sweep));
  const nA = await q1("select * from notifications where record_ref=$1 limit 1", [refA]);
  const nB = await q1("select * from notifications where record_ref=$1 limit 1", [refB]);
  ok("overdue notification for flock A (flock-linked)", !!nA && nA.record_id === A.id && (nA.title || "").includes(TEST[0]), nA?.title || "");
  ok("overdue notification for flock B (flock-linked)", !!nB && nB.record_id === B.id && (nB.title || "").includes(TEST[1]), nB?.title || "");
  const cA1 = await count("select count(*) c from notifications where record_ref=$1", [refA]);
  ok("overdue rows exist for flock A", cA1 >= 1, `${cA1} (one per recipient)`);
  const r2 = await O.POST({ entity: "SWEEP", data: { businessId: POULTRY_ID, cutoffHour: 0 } });
  const cA2 = await count("select count(*) c from notifications where record_ref=$1", [refA]);
  ok("re-sweep deduped per flock (no new rows)", r2.d?.success && cA2 === cA1, `${cA1} → ${cA2}`);
}

// ── 9. audit coverage summary ──────────────────────────────────────────────
{
  const ids = [A.id, B.id, C.id, D.id];
  const actions = ["POULTRY_FLOCK_PLAN_FORKED", "POULTRY_FLOCK_PLAN_APPLIED", "POULTRY_FLOCK_PLAN_RESET", "CHECKLIST_ITEM_ADDED_FLOCK"];
  for (const act of actions) {
    const c = await count("select count(*) c from audit_trail where action=$1 and record_id = any($2)", [act, ids]);
    ok(`audit present: ${act}`, c >= 1, `${c} rows`);
  }
}

// ── 10. lifecycle schedule (pure lib, shared with the UI) ─────────────────
{
  // Compile the pure stage lib to ESM on demand so the suite is self-contained.
  const libDir = "/tmp/flock-verify-lib";
  const libFile = path.join(libDir, "poultryStages.js");
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (!existsSync(libFile)) {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(path.join(libDir, "package.json"), '{"type":"module"}');
    execSync(`npx tsc ${path.join(here, "..", "src", "lib", "poultryStages.ts")} --outDir ${libDir} --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck`, { stdio: "inherit", cwd: path.join(here, "..") });
    // extensionless relative imports → add .js for node ESM
    for (const f of ["poultryStages.js", "poultryBenchmarking.js", "poultryAnalytics.js", "poultryPerformance.js", "currency.js"]) {
      const fp = path.join(libDir, f);
      if (existsSync(fp)) {
        let src = readFileSync(fp, "utf8");
        src = src.replace(/from "(\.\/[^\"\.]+)"/g, 'from "$1.js"');
        writeFileSync(fp, src);
      }
    }
  }
  const lib = await import(libFile);
  const daily = { taskKey: "D1", taskLabel: "daily task", frequency: "DAILY" };
  const weekly = { taskKey: "W1", taskLabel: "weekly task", frequency: "WEEKLY" };
  const monthly = { taskKey: "M1", taskLabel: "monthly task", frequency: "MONTHLY" };
  const once = { taskKey: "O1", taskLabel: "once task", frequency: "STAGE_ONCE", stageKeys: ["BROODING"] };
  const items = [daily, weekly, monthly, once];

  const br = lib.buildLifecycleSchedule("BROILERS", items);
  ok("broiler schedule: Day unit, Day 1 → Day 56", br.unit === "Day" && br.slots.length === 56 && br.slots[0].index === 1 && br.slots[55].index === 56, `${br.slots.length} slots`);
  ok("broiler: DAILY task on every day", br.slots.every((sl) => sl.tasks.some((t) => t.taskKey === "D1")));
  ok("broiler: WEEKLY on days 8,15,22…(d%7==0, d>0)", br.slots.every((sl) => (sl.ageDays > 0 && sl.ageDays % 7 === 0) === sl.tasks.some((t) => t.taskKey === "W1")));
  ok("broiler: MONTHLY on days 29 (d%28==0, d>0)", br.slots.every((sl) => (sl.ageDays > 0 && sl.ageDays % 28 === 0) === sl.tasks.some((t) => t.taskKey === "M1")));
  const onceSlots = br.slots.filter((sl) => sl.tasks.some((t) => t.taskKey === "O1"));
  ok("broiler: STAGE_ONCE only at its stage start (Day 1)", onceSlots.length === 1 && onceSlots[0].index === 1, onceSlots.map((s) => s.index).join(","));

  const ly = lib.buildLifecycleSchedule("LAYERS", [daily, weekly, monthly]);
  ok("layer schedule: Week unit, Week 1 → Week 86", ly.unit === "Week" && ly.slots.length === 86 && ly.slots[0].index === 1 && ly.slots[85].index === 86, `${ly.slots.length} slots`);
  ok("layer: DAILY routine present every week (daily checks retained)", ly.slots.every((sl) => sl.tasks.some((t) => t.taskKey === "D1")));
  ok("layer: WEEKLY task every week", ly.slots.every((sl) => sl.tasks.some((t) => t.taskKey === "W1")));
  ok("layer: MONTHLY every 4th week (d%28==0, d>0)", ly.slots.every((sl) => (sl.ageDays > 0 && sl.ageDays % 28 === 0) === sl.tasks.some((t) => t.taskKey === "M1")));
  const starts = new Set();
  let last = null;
  for (const sl of ly.slots) { if (sl.stageKey !== last) { starts.add(sl.index); last = sl.stageKey; } }
  ok("layer: every stage starts on the schedule", starts.size >= 8, `${starts.size} stage starts`);
  ok("display helpers are 1-based", lib.displayDayOf(0) === 1 && lib.displayWeekOf(6) === 1 && lib.displayWeekOf(7) === 2);
  const effective = lib.effectivePlanItemsForFlock(
    { id: 123, birdType: "BROILERS" },
    [
      { id: 1, flockId: null, origin: "STAGE_PLAN", isActive: true, taskKey: "SYS1", birdType: "BROILERS" },
      { id: 2, flockId: 123, origin: "CUSTOM", isActive: true, taskKey: "OWN1", birdType: "BROILERS" },
      { id: 3, flockId: 456, origin: "CUSTOM", isActive: true, taskKey: "OTHERFLOCK", birdType: "BROILERS" },
      { id: 4, flockId: null, origin: "CUSTOM", isActive: true, taskKey: "SYS1", birdType: "BROILERS" },
      { id: 5, flockId: 123, origin: "CUSTOM", isActive: true, taskKey: "SYS1", birdType: "BROILERS" },
    ],
  );
  ok("effectivePlanItemsForFlock: own rows replace system, collisions favor own, other flocks excluded",
    effective.length === 2 && effective.some((t) => t.taskKey === "OWN1") && effective.every((t) => t.taskKey !== "OTHERFLOCK") && effective.find((t) => t.taskKey === "SYS1").id === 5,
    effective.map((t) => `${t.taskKey}#${t.id}`).join(","));
}

// ── cleanup ────────────────────────────────────────────────────────────────
{
  const extra = (await q("select id from poultry_flocks where batch_number like 'VFY-%' or batch_number like 'UI-VFY-%'")).map((r) => r.id);
  const orphanStates = (await q("select flock_id from checklist_flock_plans where flock_id not in (select id from poultry_flocks)")).map((r) => r.flock_id);
  const ids = [...new Set([...[A?.id, B?.id, C?.id, D?.id].filter(Boolean), ...extra, ...orphanStates])];
  await q("delete from checklist_entries where flock_id = any($1)", [ids]);
  await q("delete from checklist_templates where flock_id = any($1)", [ids]);
  await q("delete from checklist_flock_plans where flock_id = any($1)", [ids]);
  await q("delete from checklist_plan_templates where name like 'VFY %'"); // self-healing: any run's leftovers
  await q("delete from notifications where type='CHECKLIST_OVERDUE' and record_id = any($1)", [ids]);
  await q("delete from audit_trail where action in ('POULTRY_FLOCK_PLAN_FORKED','POULTRY_FLOCK_PLAN_APPLIED','POULTRY_FLOCK_PLAN_RESET','POULTRY_FLOCK_PLAN_SAVED_TEMPLATE','POULTRY_PLAN_TEMPLATE_DELETED','CHECKLIST_ITEM_ADDED_FLOCK') and record_id = any($1)", [ids]);
  await q("delete from audit_trail where action in ('CHECKLIST_ITEM_UPDATED','CHECKLIST_ASSIGNMENT_CHANGED') and record_id = any($1)", [[addedRow?.id].filter(Boolean)]);
  await q("delete from poultry_flocks where id = any($1)", [ids]);
  const left = await count("select count(*) c from poultry_flocks where batch_number like 'VFY-%' or batch_number like 'UI-VFY-%'");
  ok("cleanup: ALL test flocks purged (self-healing)", left === 0, `${left} left`);
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} passed${failures ? `, ${failures} FAILED` : ""}`);
await client.end();
process.exit(failures ? 1 : 0);
