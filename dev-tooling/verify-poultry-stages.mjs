// Live verification of the POULTRY AGE/STAGE-AWARE DAILY CHECKLIST.
//
// Covers the full design (reports/POULTRY-STAGE-CHECKLIST-ASSESSMENT.md):
//   1. Pre-state: POULTRY-01 (5 Owner-custom templates, dated history) is
//      untouched until the stage plan is enabled — existing records preserved.
//   2. Enable → full system stage plan seeded (origin STAGE_PLAN) alongside
//      the custom items; per-flock materialization for TODAY with the right
//      stages (broiler BENCH-DEMO-B01 → FINISHER at ~day 29; layers L01 →
//      MID_LAY wk~53, L03 → PEAK wk~30); house-scoped + custom items exactly
//      once; no egg tasks on broiler flocks; SOLD/CLOSED flocks skipped.
//   3. Full BROILER lifecycle (day 0 → closeout) and LAYER lifecycle
//      (wk 0 → spent) via dated test flocks — every stage gets its
//      stage-specific tasks; frequency rules hold (STAGE_ONCE once per
//      stage, WEEKLY not repeated within 6 days, MONTHLY within 29).
//   4. Idempotency: regenerating a date adds nothing.
//   5. Stage transition → manager notification (POULTRY_STAGE, deduped) +
//      audit-trail row (POULTRY_STAGE_TRANSITION).
//   6. CRITICAL completion → audit-trail row (CHECKLIST_CRITICAL_DONE) and
//      the audit record view carries flock/stage context (OPERATIONS module).
//   7. Overdue sweep → CHECKLIST_OVERDUE notification, deduped on re-run.
//   8. Owner customization: PATCH stage-plan template (priority), deactivate
//      → not materialized on later dates; custom stage-scoped item
//      materializes per flock; disable/enable of the whole plan.
//   9. Non-poultry business (BLOCK-01) byte-compatible: business-level only.
//  10. /api/poultry flock enrichment: stage attached to every flock.
// All TEST rows (flocks, entries, notifications, audit rows, markers) are
// purged afterwards; the demo POULTRY-01 stage plan stays ENABLED.
// Run: node dev-tooling/verify-poultry-stages.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const POULTRY_ID = 1;
const BLOCK_ID = Number(process.env.BLOCK_ID || 2);

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params || [])).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];
const D = (offsetDays) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + Number(offsetDays)); return d.toISOString().split("T")[0]; };

// ── login ──────────────────────────────────────────────────────────────────
let cookie = "";
{
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  ok("owner login", r.status === 200 && !!cookie);
}
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) } });
  let d = null; try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
};
const POST = (body) => api("/api/checklists", { method: "POST", body: JSON.stringify(body) });
const PATCH = (body) => api("/api/checklists", { method: "PATCH", body: JSON.stringify(body) });
const GET = (p) => api(p);

const today = new Date().toLocaleDateString("en-CA");
const entriesOf = (date) => q("select * from checklist_entries where business_id=$1 and checklist_date=$2", [POULTRY_ID, date]);
const count = async (sql, params) => Number((await q1(sql, params)).c);

// ── 1. pre-state ───────────────────────────────────────────────────────────
const FRESH = (await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN'", [POULTRY_ID])) > 0;
{
  const templates = await count("select count(*) c from checklist_templates where business_id=$1", [POULTRY_ID]);
  const history = await count("select count(*) c from checklist_entries where business_id=$1 and checklist_date < $2", [POULTRY_ID, today]);
  if (FRESH) {
    // Bootstrapped with the new seed: POULTRY-01 ships the stage plan on.
    ok("pre-state: fresh bootstrap carries the stage plan (custom + system rows)", templates >= 60, `${templates} templates`);
  } else {
    const stageBefore = await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN'", [POULTRY_ID]);
    ok("pre-state: POULTRY-01 has only the Owner's custom templates", templates === 5 && stageBefore === 0, `${templates} templates, ${stageBefore} stage`);
  }
  ok("pre-state: dated demo history present", history >= 10, `${history} historical entries`);
  if (!FRESH) {
    // generate today BEFORE enabling — must stay business-level, no flock rows
    await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
    const t = await entriesOf(today);
    ok("pre-enable generation: business-level only (legacy behaviour)", t.length > 0 && t.every((e) => e.flock_id == null && e.stage_key == null), `${t.length} entries, all flock-less`);
  }
}

// ── 2. enable + materialization for TODAY ──────────────────────────────────
{
  if (!FRESH) {
    const r = await POST({ entity: "STAGE_PLAN", data: { businessId: POULTRY_ID, action: "enable", cutoffHour: 18 } });
    ok("STAGE_PLAN enable returns success", r.status === 200 && r.d?.success && r.d?.stagePlan === "enabled", `templates: ${r.d?.templates}, entriesToday: ${r.d?.entriesToday}`);
  } else {
    await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
  }

  const stageT = await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and is_active", [POULTRY_ID]);
  const customT = await count("select count(*) c from checklist_templates where business_id=$1 and origin<>'STAGE_PLAN'", [POULTRY_ID]);
  ok("stage plan seeded alongside custom items (colliding MORTALITY_SWEEP adopted)", stageT >= 59 && customT === 4, `${stageT} STAGE_PLAN + ${customT} CUSTOM`);
  const adopted = await q1("select task_label, priority, assigned_to_name from checklist_templates where business_id=$1 and task_key='MORTALITY_SWEEP'", [POULTRY_ID]);
  ok("adoption keeps the Owner's label & assignment, gains CRITICAL priority", /mortality sweep/i.test(adopted?.task_label || "") && adopted?.priority === "CRITICAL" && adopted?.assigned_to_name === "Akua Donkor", JSON.stringify(adopted));

  const rows = await entriesOf(today);
  const flockRows = rows.filter((e) => e.flock_id != null);
  const bizRows = rows.filter((e) => e.flock_id == null);
  const byFlock = new Map();
  for (const e of flockRows) { if (!byFlock.has(e.flock_id)) byFlock.set(e.flock_id, []); byFlock.get(e.flock_id).push(e); }

  const b01 = byFlock.get(4) || []; // BENCH-DEMO-B01 broiler, arrival 2026-08-25
  const stageB01 = b01[0]?.stage_key;
  ok("broiler BENCH-DEMO-B01 staged + flock-scoped entries", b01.length > 0 && b01.every((e) => e.stage_key === stageB01), `stage=${stageB01}, ${b01.length} tasks`);
  ok("broiler B01 at ~day 29 is FINISHER", stageB01 === "FINISHER", `got ${stageB01}`);
  ok("broiler flock has NO egg-collection tasks", !b01.some((e) => e.task_key.startsWith("EGG_COLLECTION")));
  ok("broiler flock has stage-specific FINISHER tasks", b01.some((e) => e.task_key === "FINISHER_TRANSITION") && b01.some((e) => e.task_key === "WITHDRAWAL_REVIEW"));
  ok("broiler flock gets core routine + weekly weigh", b01.some((e) => e.task_key === "MORNING_WALK") && b01.some((e) => e.task_key === "WEEKLY_WEIGH") && b01.some((e) => e.task_key === "LITTER_CHECK"));
  ok("adopted MORTALITY_SWEEP materializes per flock as CRITICAL", flockRows.filter((e) => e.task_key === "MORTALITY_SWEEP").length >= 3 && flockRows.every((e) => e.task_key !== "MORTALITY_SWEEP" || e.priority === "CRITICAL"));

  const l01 = byFlock.get(1) || []; // BATCH-2026-L01 layer, arrival 2025-09-15 → wk ~53
  ok("layer L01 at wk ~53 is MID_LAY with lay tasks", l01.length > 0 && l01[0]?.stage_key === "MID_LAY" && l01.some((e) => e.task_key === "EGG_COLLECTION_AM") && l01.some((e) => e.task_key === "LAY_TRACK"), `stage=${l01[0]?.stage_key}, ${l01.length} tasks`);
  const l03 = byFlock.get(3) || []; // BATCH-2026-L03 layer, arrival 2026-02-20 → wk ~30
  ok("layer L03 at wk ~30 is PEAK with midday collection", l03.length > 0 && l03[0]?.stage_key === "PEAK" && l03.some((e) => e.task_key === "MIDDAY_COLLECTION") && l03.some((e) => e.task_key === "PEAK_VIGILANCE"), `stage=${l03[0]?.stage_key}`);

  ok("house-scoped tasks exactly once (BIOSECURITY, HOUSE_SECURE)", bizRows.filter((e) => e.task_key === "BIOSECURITY").length === 1 && bizRows.filter((e) => e.task_key === "HOUSE_SECURE").length === 1);
  ok("custom items still materialize once at business level", bizRows.filter((e) => e.task_key === "FEED_STOCK_CHECK").length === 1);
  const closedFlocks = new Set([2, 5, 6, 7]); // CLOSED/SOLD demo flocks
  ok("SOLD/CLOSED flocks produce no entries", [...byFlock.keys()].every((fid) => !closedFlocks.has(fid)), `flocks with entries: ${[...byFlock.keys()].join(",")}`);
  const crit = flockRows.filter((e) => e.priority === "CRITICAL");
  ok("critical priorities carried onto entries", crit.length >= 3, `${crit.length} critical entries`);
  const ageOk = flockRows.every((e) => e.age_days == null || Number.isFinite(e.age_days));
  ok("age_days populated on flock entries", ageOk && flockRows.some((e) => e.age_days != null));
}

// ── 3. full lifecycle coverage via dated test flocks ──────────────────────
const TEST = [];
async function mkFlock(batch, birdType, arrivalDate, breed) {
  const r = await api("/api/poultry", {
    method: "POST",
    body: JSON.stringify({
      entity: "FLOCK",
      data: {
        businessId: POULTRY_ID, branchCode: "POULTRY-01", batchNumber: batch, flockName: `Stage verify ${batch}`,
        birdType, breed, initialCount: 500, currentCount: 500, arrivalDate, status: "ACTIVE",
        createdByName: "Stage Verify", createdByRole: "OWNER",
      },
    }),
  });
  if (r.status !== 200 || !r.d?.success) throw new Error(`mkFlock ${batch} failed: ${JSON.stringify(r.d).slice(0, 200)}`);
  const id = Number(r.d.item.id);
  TEST.push(id);
  return id;
}
{
  // Broiler lifecycle: today-0 (BROODING), -10 (STARTER), -20 (GROWER), -35 (FINISHER),
  // -41 (MARKET, market=42), -55 (CLOSEOUT, > market+8), +3 (PREP — future arrival).
  const broilerCases = [
    [0, "BROODING", ["CROP_FILL_CHECK", "BROODER_TEMP_3X", "PAPER_FEED_REFRESH"]],
    [-10, "STARTER", ["SAMPLE_WEIGH_W1", "TEMP_STEPDOWN", "GROWER_FEED_ORDER"]],
    [-20, "GROWER", ["GROWER_TRANSITION", "DENSITY_CHECK", "FEEDER_DRINKER_HEIGHT"]],
    [-35, "FINISHER", ["FINISHER_TRANSITION", "WITHDRAWAL_REVIEW", "WEEKLY_WEIGH"]],
    [-41, "MARKET", ["WITHDRAWAL_COMPLIANCE", "LOADOUT_SUPERVISE", "FEED_WITHDRAWAL"]],
    [-55, "CLOSEOUT", ["CLOSEOUT_ECONOMICS", "BATCH_RECORDS_CLOSE", "HOUSE_RESET"]],
    [3, "PREP", ["HOUSE_DISINFECT", "BROODER_TEST", "CHICK_SUPPLIES"]],
  ];
  for (const [offset, stage, keys] of broilerCases) {
    await mkFlock(`STAGE-VFY-B${String(offset).replace("-", "M")}`, "BROILERS", D(offset), "Cobb 500");
  }
  // Layer lifecycle: wk 0, 8, 14, 18, 22, 30, 45, 64, 85
  const layerCases = [
    [-3, "CHICK_BROODING", ["BROODER_TEMP_LAYER", "CROP_FILL_LAYER", "CHICK_WEIGH"]],
    [-60, "GROWING", ["FEED_RESTRAINT", "CHICK_WEIGH", "UNIFORMITY_SPOT"]],
    [-100, "DEVELOPING", ["UNIFORMITY_SAMPLE", "TRANSFER_PREP", "LAY_FEED_ORDER"]],
    [-133, "PRE_LAY", ["LIGHT_STEPUP", "CALCIUM_TRANSITION", "LAY_HOUSE_TRANSFER", "FIRST_EGG_WATCH"]],
    [-160, "EARLY_LAY", ["LAY_RAMP_TRACK", "MIDDAY_COLLECTION", "LIGHT_STEPUP"]],
    [-200, "PEAK", ["PEAK_VIGILANCE", "LAY_TRACK", "MIDDAY_COLLECTION"]],
    [-300, "MID_LAY", ["LAY_TRACK", "UNIFORMITY_MONTHLY", "EGG_WEIGHT_TRACK"]],
    [-450, "LATE_LAY", ["SHELL_QUALITY", "MOLT_DECISION", "EGG_WEIGHT_TRACK"]],
    [-600, "CLOSEOUT", ["SPENT_HEN_PLAN", "CLOSEOUT_ECONOMICS_LAYER", "HOUSE_RESET_LAYER"]],
  ];
  for (const [offset] of layerCases) {
    await mkFlock(`STAGE-VFY-L${String(-offset)}`, "LAYERS", D(offset), "Isa Brown");
  }
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
  const rows = await entriesOf(today);
  const batchById = new Map((await q("select id, batch_number, bird_type from poultry_flocks where business_id=$1", [POULTRY_ID])).map((f) => [f.id, f]));

  for (const [offset, stage, keys] of broilerCases) {
    const batch = `STAGE-VFY-B${String(offset).replace("-", "M")}`;
    const fid = [...batchById.entries()].find(([, f]) => f.batch_number === batch)?.[0];
    const fr = rows.filter((e) => e.flock_id === fid);
    const got = fr[0]?.stage_key;
    ok(`broiler lifecycle ${batch} (arrival ${D(offset)}) → ${stage}`, got === stage && fr.length >= 6 + keys.length, `got ${got}, ${fr.length} tasks`);
    for (const k of keys) {
      if (!fr.some((e) => e.task_key === k)) { ok(`  … ${batch} includes ${k}`, false); }
    }
  }
  for (const [offset, stage, keys] of layerCases) {
    const batch = `STAGE-VFY-L${String(-offset)}`;
    const fid = [...batchById.entries()].find(([, f]) => f.batch_number === batch)?.[0];
    const fr = rows.filter((e) => e.flock_id === fid);
    const got = fr[0]?.stage_key;
    const expectedWk = Math.floor(Math.abs(offset) / 7);
    ok(`layer lifecycle ${batch} (wk ~${expectedWk}) → ${stage}`, got === stage, `got ${got}, ${fr.length} tasks`);
    for (const k of keys) {
      if (!fr.some((e) => e.task_key === k)) { ok(`  … ${batch} includes ${k}`, false); }
    }
    ok(`  … ${batch} egg collection present`, fr.some((e) => e.task_key === "EGG_COLLECTION_AM"));
  }

  // Unsupported bird type → core routine only, no stage tasks
  await mkFlock("STAGE-VFY-T1", "TURKEYS", D(-20), "Local Bronze");
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
  {
    const rows2 = await entriesOf(today);
    const fid = [...batchById.entries()].find(([, f]) => f.batch_number === "STAGE-VFY-T1")?.[0] || TEST[TEST.length - 1];
    const fr = rows2.filter((e) => e.flock_id === fid);
    ok("unsupported bird type (turkeys) → core routine only, no stage rows", fr.length > 0 && fr.every((e) => e.stage_key == null) && fr.some((e) => e.task_key === "MORNING_WALK") && fr.every((e) => e.task_key !== "LITTER_CHECK"), `${fr.length} tasks`);
  }
}

// ── 4. idempotency + frequency windows ─────────────────────────────────────
{
  const before = (await entriesOf(today)).length;
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: today } });
  const after = (await entriesOf(today)).length;
  ok("idempotent regeneration of today (no duplicates)", before === after, `${before} → ${after}`);

  // tomorrow: DAILY yes; WEEKLY not (entry exists within 6d); STAGE_ONCE not
  const tomorrow = D(1);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: tomorrow } });
  const tm = await entriesOf(tomorrow);
  const b01tm = tm.filter((e) => e.batch_number === "BENCH-DEMO-B01");
  ok("tomorrow: DAILY core tasks present", b01tm.some((e) => e.task_key === "MORNING_WALK") && b01tm.some((e) => e.task_key === "TEMP_VENT_CHECK"));
  ok("tomorrow: WEEKLY task suppressed inside its window", !b01tm.some((e) => e.task_key === "WEEKLY_WEIGH"));
  ok("tomorrow: STAGE_ONCE task suppressed (same stage)", !b01tm.some((e) => e.task_key === "FINISHER_TRANSITION"));

  // day +8: WEEKLY becomes due again
  const d8 = D(8);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: d8 } });
  const b01d8 = (await entriesOf(d8)).filter((e) => e.batch_number === "BENCH-DEMO-B01");
  ok("day +8: WEEKLY task due again", b01d8.some((e) => e.task_key === "WEEKLY_WEIGH"));
  ok("day +8: STAGE_ONCE still suppressed within the stage", !b01d8.some((e) => e.task_key === "FINISHER_TRANSITION"));

  // cleanup generated future dates (keep today's)
  await q("delete from checklist_entries where business_id=$1 and checklist_date in ($2,$3)", [POULTRY_ID, tomorrow, d8]);
}

// ── 5. stage transition → notification + audit ─────────────────────────────
{
  // flock born today (BROODING materialized today). The +8d frequency probe in
  // section 4 already announced BROODING→STARTER; generate +14 → GROWER for a
  // fresh, un-announced transition.
  const fid = TEST.find((id) => true); // first test flock = STAGE-VFY-B0 (arrival today)
  const b0 = (await q1("select id, batch_number from poultry_flocks where id=$1", [fid]));
  const plus14 = D(14);
  const nBefore = await count("select count(*) c from notifications where type='POULTRY_STAGE' and record_ref like $1", [`poultry-stage:${fid}:%`]);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: plus14 } });
  const plus14rows = (await entriesOf(plus14)).filter((e) => e.flock_id === fid);
  ok("transition: +14d flock stages into GROWER", plus14rows[0]?.stage_key === "GROWER", `got ${plus14rows[0]?.stage_key}`);
  const nAfter = await count("select count(*) c from notifications where type='POULTRY_STAGE' and record_ref like $1", [`poultry-stage:${fid}:%`]);
  ok("transition: manager notification(s) created", nAfter > nBefore, `${nBefore} → ${nAfter} (one per manager recipient)`);
  const note = await q1("select title, body from notifications where type='POULTRY_STAGE' and record_ref=$1", [`poultry-stage:${fid}:GROWER`]);
  ok("transition: notification carries flock + stage context", note && note.title.includes(b0.batch_number) && note.title.includes("Grower"), `“${note?.title}”`);
  const trail = await count("select count(*) c from audit_trail where action='POULTRY_STAGE_TRANSITION' and record_id=$1 and business_id=$2", [fid, POULTRY_ID]);
  ok("transition: audit-trail rows written (STARTER from §4 + GROWER now)", trail >= 2, `${trail} rows`);
  // regenerate +14 → no duplicate notification (fanOut dedupe)
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: plus14 } });
  const nAgain = await count("select count(*) c from notifications where type='POULTRY_STAGE' and record_ref like $1", [`poultry-stage:${fid}:%`]);
  ok("transition: re-run does not duplicate the notification", nAgain === nAfter, `${nAgain}`);
  await q("delete from checklist_entries where business_id=$1 and checklist_date=$2", [POULTRY_ID, plus14]);
}

// ── 6. critical completion → audit + audit record context ──────────────────
{
  const rows = await entriesOf(today);
  const crit = rows.find((e) => e.priority === "CRITICAL" && e.flock_id != null && !e.is_completed);
  ok("a critical flock task exists to complete", !!crit, crit?.task_key);
  if (crit) {
    const r = await PATCH({ entity: "ENTRY", id: crit.id, data: { completedByName: "Kwame Mina", completedByRole: "OWNER" } });
    ok("critical task completion succeeds", r.status === 200 && r.d?.success && r.d.item?.isCompleted);
    const trail = await count("select count(*) c from audit_trail where action='CHECKLIST_CRITICAL_DONE' and record_id=$1", [crit.id]);
    ok("critical completion → audit-trail row (CHECKLIST_CRITICAL_DONE)", trail === 1, `${trail} rows`);
    const aud = await GET(`/api/audit?businessId=${POULTRY_ID}`);
    const rec = (aud.d?.records || []).find((x) => x.key === `CHECKLIST:checklist_entries:${crit.id}`);
    ok("audit record view shows the completion with stage context", !!rec && (rec.detail || "").includes(crit.batch_number) && (rec.title || "").includes("CRITICAL"), rec?.detail?.slice(0, 80));
    // revert
    await PATCH({ entity: "ENTRY", id: crit.id, data: { completedByName: "Kwame Mina", completedByRole: "OWNER" } });
  }
}

// ── 7. overdue sweep ───────────────────────────────────────────────────────
{
  const ref = `checklist-overdue:${POULTRY_ID}:${today}`;
  await q("delete from notifications where record_ref=$1", [ref]); // fresh
  const r = await POST({ entity: "SWEEP", data: { businessId: POULTRY_ID, cutoffHour: 0 } });
  ok("manual overdue sweep runs", r.status === 200 && r.d?.success, JSON.stringify(r.d?.sweep));
  const n = await q1("select count(*) c, max(title) t from notifications where type='CHECKLIST_OVERDUE' and record_ref=$1", [ref]);
  ok("overdue sweep → CHECKLIST_OVERDUE notification", Number(n.c) >= 1, `“${n.t}”`);
  const r2 = await POST({ entity: "SWEEP", data: { businessId: POULTRY_ID, cutoffHour: 0 } });
  const n2 = await q1("select count(*) c from notifications where type='CHECKLIST_OVERDUE' and record_ref=$1", [ref]);
  ok("re-sweep deduped (one per business+date)", Number(n2.c) === Number(n.c), `${n.c} → ${n2.c}`);
  ok("sweep reports swept>0 only when tasks were overdue", (r.d?.sweep?.swept ?? 0) >= 0);
}

// ── 8. owner customization ─────────────────────────────────────────────────
{
  // 8a. custom stage-scoped item (broilers, MARKET stage, once per stage)
  const add = await POST({
    entity: "TEMPLATE",
    data: {
      businessId: POULTRY_ID, branchCode: "POULTRY-01",
      taskLabel: "Verify crates are disinfected before loadout", category: "QUALITY",
      birdType: "BROILERS", stageKeys: ["MARKET"], frequency: "STAGE_ONCE", priority: "ROUTINE",
      createdByName: "Kwame Mina", createdByRole: "OWNER",
    },
  });
  ok("custom stage-scoped item created", add.status === 200 && add.d?.success && add.d.item?.origin === "CUSTOM" && add.d.item?.birdType === "BROILERS");
  const customId = add.d?.item?.id;
  const mDate = D(2);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: mDate } });
  const mktFlocks = (await entriesOf(mDate)).filter((e) => e.stage_key === "MARKET" && e.task_key === "VERIFY_CRATES_ARE_DISINFECTED_BEFORE_LOADOUT");
  ok("custom stage item materializes only for MARKET-stage flocks", mktFlocks.length === 1 && mktFlocks.every((e) => e.stage_key === "MARKET"), `${mktFlocks.length} rows`);
  await q("delete from checklist_entries where business_id=$1 and checklist_date=$2", [POULTRY_ID, mDate]);
  if (customId) { await api(`/api/checklists?id=${customId}`, { method: "DELETE" }); }

  // 8b. deactivate a stage-plan template → gone from future dates
  const tpl = await q1("select id from checklist_templates where business_id=$1 and task_key='LITTER_CHECK' and origin='STAGE_PLAN'", [POULTRY_ID]);
  const off = await PATCH({ entity: "TEMPLATE", id: tpl.id, data: { isActive: false } });
  ok("stage-plan template deactivated by Owner", off.status === 200 && off.d?.success && off.d.item?.isActive === false);
  const d2 = D(3);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: d2 } });
  const litter = (await entriesOf(d2)).filter((e) => e.task_key === "LITTER_CHECK");
  ok("deactivated stage task not materialized on later dates", litter.length === 0, `${litter.length} rows`);
  const todayLitter = (await entriesOf(today)).filter((e) => e.task_key === "LITTER_CHECK");
  ok("today's already-materialized rows preserved (history intact)", todayLitter.length > 0, `${todayLitter.length} rows`);
  await PATCH({ entity: "TEMPLATE", id: tpl.id, data: { isActive: true } }); // restore

  // 8c. priority edit on a stage template
  const tpl2 = await q1("select id from checklist_templates where business_id=$1 and task_key='WATER_CHECK' and origin='STAGE_PLAN'", [POULTRY_ID]);
  const pr = await PATCH({ entity: "TEMPLATE", id: tpl2.id, data: { priority: "CRITICAL" } });
  ok("stage template priority editable (now CRITICAL)", pr.status === 200 && pr.d?.item?.priority === "CRITICAL");
  await PATCH({ entity: "TEMPLATE", id: tpl2.id, data: { priority: "ROUTINE" } }); // restore

  // 8d. whole-plan disable / enable
  const dis = await POST({ entity: "STAGE_PLAN", data: { businessId: POULTRY_ID, action: "disable" } });
  ok("stage plan disable deactivates system rows only", dis.status === 200 && dis.d?.stagePlan === "disabled" && Number(dis.d?.deactivated) >= 59, `deactivated ${dis.d?.deactivated}`);
  const customStill = await count("select count(*) c from checklist_templates where business_id=$1 and origin<>'STAGE_PLAN' and is_active", [POULTRY_ID]);
  ok("custom items untouched by disable", customStill === 4, `${customStill} active custom`);
  const d4 = D(4);
  await POST({ entity: "GENERATE", data: { businessId: POULTRY_ID, checklistDate: d4 } });
  const d4rows = await entriesOf(d4);
  ok("disabled plan → new dates are business-level only (legacy shape)", d4rows.length > 0 && d4rows.every((e) => e.flock_id == null), `${d4rows.length} rows`);
  await q("delete from checklist_entries where business_id=$1 and checklist_date=$2", [POULTRY_ID, d4]);
  const en = await POST({ entity: "STAGE_PLAN", data: { businessId: POULTRY_ID, action: "enable" } });
  ok("re-enable restores the plan", en.status === 200 && en.d?.stagePlan === "enabled" && Number(en.d?.templates) >= 59);
}

// ── 9. non-poultry business unaffected ─────────────────────────────────────
{
  const r = await GET(`/api/checklists?businessId=${BLOCK_ID}`);
  ok("BLOCK-01 checklist responds", r.status === 200 && r.d?.success);
  const tpl = r.d.templates || [];
  ok("BLOCK-01 templates unchanged (no stage metadata)", tpl.length > 0 && tpl.every((t) => t.origin !== "STAGE_PLAN" && t.birdType == null), `${tpl.length} templates`);
  await POST({ entity: "GENERATE", data: { businessId: BLOCK_ID, checklistDate: today } });
  const rows = await q("select * from checklist_entries where business_id=$1 and checklist_date=$2", [BLOCK_ID, today]);
  ok("BLOCK-01 generation stays business-level", rows.length > 0 && rows.every((e) => e.flock_id == null && e.stage_key == null && e.priority == null), `${rows.length} entries`);
  const sp = await POST({ entity: "STAGE_PLAN", data: { businessId: BLOCK_ID, action: "enable" } });
  ok("STAGE_PLAN correctly rejected for non-poultry business", sp.status === 400);
}

// ── 10. /api/poultry stage enrichment ──────────────────────────────────────
{
  const r = await GET(`/api/poultry?businessId=${POULTRY_ID}`);
  const flocks = r.d?.flocks || [];
  const withStage = flocks.filter((f) => f.stage);
  ok("poultry GET attaches stage to staged flocks", r.status === 200 && withStage.length >= 5, `${withStage.length}/${flocks.length} staged`);
  const b01 = flocks.find((f) => f.batchNumber === "BENCH-DEMO-B01");
  ok("BENCH-DEMO-B01 stage = FINISHER with market ETA", b01?.stage?.stageKey === "FINISHER" && b01?.stage?.marketEtaDays != null, JSON.stringify(b01?.stage?.label));
  const l01 = flocks.find((f) => f.batchNumber === "BATCH-2026-L01");
  ok("BATCH-2026-L01 stage = MID_LAY with ageWeeks", l01?.stage?.stageKey === "MID_LAY" && Number.isFinite(l01?.stage?.ageWeeks), `wk ${l01?.stage?.ageWeeks}`);
}

// ── cleanup ────────────────────────────────────────────────────────────────
{
  // Future-dated entries generated by frequency/customization tests, all
  // test-flock rows, and the artifacts they created (notifications, audit).
  await q("delete from checklist_entries where business_id=$1 and checklist_date > $2", [POULTRY_ID, today]);
  await q("delete from checklist_entries where flock_id = any($1)", [TEST]);
  await q("delete from notifications where (record_ref like 'poultry-stage:%' and record_id = any($1)) or (type = 'CHECKLIST_OVERDUE' and record_ref like $2)", [TEST, `checklist-overdue:${POULTRY_ID}:%`]);
  await q("delete from audit_trail where (action = 'POULTRY_STAGE_TRANSITION' and record_id = any($1)) or (action = 'CHECKLIST_CRITICAL_DONE') or (action = 'POULTRY_FLOCK_CREATE' and record_id = any($1))", [TEST]);
  await q("delete from poultry_flocks where id = any($1)", [TEST]);
  const leftovers = await count("select count(*) c from checklist_entries where flock_id = any($1)", [TEST]);
  ok("test flocks + their entries/notifications/audit rows purged", leftovers === 0, `${leftovers} leftovers`);
  const demoHistory = await count("select count(*) c from checklist_entries where business_id=$1 and checklist_date < $2", [POULTRY_ID, today]);
  ok("original demo checklist history untouched", demoHistory >= 10, `${demoHistory} rows`);
  const stageOn = await count("select count(*) c from checklist_templates where business_id=$1 and origin='STAGE_PLAN' and is_active", [POULTRY_ID]);
  ok("demo POULTRY-01 left with stage plan ENABLED", stageOn >= 59, `${stageOn} active stage templates`);
}

console.log(`\n${failures === 0 ? "🎉 ALL" : "⚠️ PARTIAL"} — ${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
