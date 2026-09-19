#!/usr/bin/env node
/**
 * Audit & Review Notification System — end-to-end verification.
 *
 * Covers every clause of the notification contract, across modules & roles:
 *
 *  A) FLAG → responsible user is notified on the bell with: item ref, reason,
 *     priority, auditor, business/branch, and an explicit REQUIRED ACTION.
 *  B) Managers always WATCH flags in their businesses; the org OWNER is
 *     escalated on HIGH/CRITICAL (and always when no assignee resolves);
 *     MEDIUM never spams the Owner. Actors never notify themselves.
 *  C) Tenant isolation: an unrelated Owner + a same-display-name user in an
 *     UNRELATED organization receive/act on NOTHING (assignee resolution,
 *     "my issues" listing, and RESPOND all org-guarded).
 *  D) Read tracking: per-id PATCH marks only the caller's rows; mark-all.
 *  E) Lifecycle sync: MARK_RESOLVED retires every earlier bell item for the
 *     issue; the reviewer gets the only fresh action item; VERIFY retires
 *     that too and hands the assignee a final closed notice; closed issues
 *     refuse further actions.
 *  F) Module sweep: one flagged record per business module that has data.
 *
 * Usage: BASE=http://127.0.0.1:3000 node dev-tooling/audit-notify-verify.mjs
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}

const H = (t) => ({ "x-gomina-session": t, "content-type": "application/json" });
async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`login failed for ${email}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 140)}`);
  return { token: j.sessionToken, user: j.user };
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H(token), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = (t, p) => api(t, "GET", p);
const post = (t, p, b) => api(t, "POST", p, b);
const patch = (t, p, b) => api(t, "PATCH", p, b);

/** Rows of the caller's bell that reference a specific audit issue. */
async function notifsFor(token, issueId) {
  const r = await get(token, "/api/notifications");
  const rows = (r.body.notifications || []).filter((n) => Number(n.issueId) === Number(issueId));
  return { rows, unreadCount: r.body.unreadCount || 0, openAssignedCount: r.body.openAssignedCount || 0 };
}
async function flag(token, rec, extra = {}) {
  return post(token, "/api/audit", {
    action: "FLAGGED",
    recordType: rec.recordType, recordSource: rec.recordSource ?? null, recordId: rec.recordId,
    issueTitle: extra.issueTitle, reason: extra.reason || "Verification flag",
    comment: extra.comment || "auto-verify",
    ...(extra.priority ? { priority: extra.priority } : {}),
    assignedUserId: extra.assignedUserId ?? null,
  });
}

async function main() {
  console.log(`\n=== Audit & Review Notification verification ===`);
  const R = String(Date.now()).slice(-6);
  const createdIssueIds = [];

  // ── Actors ──────────────────────────────────────────────────────────────
  const kwame = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  check("super-admin (org-1 Owner) login", kwame.user.isSuperAdmin === true && kwame.user.role === "OWNER");
  const abena = await login("abena.gm@gomina360.com", "GoMina@User2");
  check("general-manager (org-1) login", ["GENERAL_MANAGER", "OWNER"].includes(abena.user.role), abena.user.role);

  // Unrelated organization + its own owner (fresh fixture each run).
  const orgRes = await post(kwame.token, "/api/admin/organizations", { name: `AU Unrelated Org ${R}`, ownerName: `Unrelated Owner ${R}`, ownerEmail: `aub.owner${R}@demo.local` });
  check("fixture: unrelated organization created", orgRes.status === 200 && orgRes.body.success === true, JSON.stringify(orgRes.body).slice(0, 160));
  const ownerBPass = orgRes.body.ownerPassword || orgRes.body.initialPassword || orgRes.body.password;
  const ownerB = await login(`aub.owner${R}@demo.local`, ownerBPass);
  check("fixture: unrelated owner login", !!ownerB.token);
  const bizBRes = await post(ownerB.token, "/api/businesses", { name: `Unrelated Biz ${R}`, category: "Other" });
  const bizBId = bizBRes.body?.business?.id ?? bizBRes.body?.id;
  check("fixture: unrelatedOwner business created", !!bizBId, JSON.stringify(bizBRes.body).slice(0, 120));
  const TWIN_NAME = `Shared Worker ${R}`;
  const twinPw = `Twin@${R}`;
  const twinRes = await post(ownerB.token, "/api/users", { name: TWIN_NAME, email: `aub.twin${R}@demo.local`, password: twinPw, role: "WORKER", assignedBusinessId: bizBId });
  const twinId = twinRes.body?.user?.id;
  check("fixture: twin worker (same display name, foreign org) created", !!twinId, JSON.stringify(twinRes.body).slice(0, 140));
  const twin = await login(`aub.twin${R}@demo.local`, twinPw);
  check("fixture: twin login", twin.user.id === twinId);

  // Org-1 assignee worker + auditor (fresh fixture each run).
  const init = await get(kwame.token, "/api/init");
  const org1Biz = (init.body.businesses || []).filter((b) => Number(b.ownerId) === 1);
  const MAIN_BIZ = org1Biz.find((b) => Number(b.id) === 1) || org1Biz[0];
  check("fixture: org-1 main business known", !!MAIN_BIZ, MAIN_BIZ ? `${MAIN_BIZ.id} ${MAIN_BIZ.name}` : "none");
  const workerPw = `Worker@${R}`;
  const wRes = await post(kwame.token, "/api/users", { name: `Assignee Worker ${R}`, email: `au.worker${R}@demo.local`, password: workerPw, role: "WORKER", assignedBusinessId: MAIN_BIZ.id });
  check("fixture: assignee worker created", !!wRes.body?.user?.id, JSON.stringify(wRes.body).slice(0, 140));
  const assignee = await login(`au.worker${R}@demo.local`, workerPw);
  const audPw = `Auditor@${R}`;
  const aRes = await post(kwame.token, "/api/users", { name: `Auditor One ${R}`, email: `au.auditor${R}@demo.local`, password: audPw, role: "WORKER", assignedBusinessId: MAIN_BIZ.id });
  check("fixture: auditor account created", !!aRes.body?.user?.id);
  const auditor = await login(`au.auditor${R}@demo.local`, audPw);
  const ALL_MODULES = ["OPERATIONS", "FINANCE", "INVENTORY", "EMPLOYEES", "PAYROLL", "ATTENDANCE", "ASSETS", "CCTV", "USERS"];
  const gRes = await post(kwame.token, "/api/audit", { action: "GRANT", userId: auditor.user.id, businessId: MAIN_BIZ.id, modules: ALL_MODULES });
  check("fixture: auditor granted all modules on main business", gRes.status === 200 && gRes.body.success === true, JSON.stringify(gRes.body).slice(0, 160));

  // Records to flag, from the audit center's own record list.
  const auditPage = await get(kwame.token, "/api/audit");
  const records = (auditPage.body.records || []).filter((r) => org1Biz.some((b) => Number(b.id) === Number(r.businessId)));
  check("audit records visible to reviewer", records.length > 0, `${records.length} rows`);
  const byModule = new Map();
  for (const r of records) if (!byModule.has(r.module)) byModule.set(r.module, r);
  check("module sweep: at least one record in ≥4 modules", byModule.size >= 4, [...byModule.keys()].join(","));
  const finRec = records.find((r) => r.module === "FINANCE" && Number(r.businessId) === Number(MAIN_BIZ.id)) || byModule.get("FINANCE");
  check("finance record on main business for auditor-scoped flags", !!finRec);

  // Clean bell baseline for every actor (mark everything pre-existing read).
  for (const t of [kwame, abena, assignee, auditor, twin, ownerB]) {
    await patch(t.token, "/api/notifications", { all: true });
  }
  check("baseline: bells zeroed (mark-all works)", (await get(assignee.token, "/api/notifications")).body.unreadCount === 0);

  // ── A/B) Module sweep — reviewer flags each module (HIGH, assigned) ──────
  const sweep = [];
  for (const [mod, rec] of byModule) {
    const title = `AU ${R} ${mod} sweep`;
    const reason = `Audit flag reason for ${mod} (${R})`;
    const res = await flag(kwame.token, rec, { issueTitle: title, reason, priority: "HIGH", assignedUserId: assignee.user.id });
    check(`flag ${mod}: created`, res.status === 200 && res.body.success === true, JSON.stringify(res.body).slice(0, 140));
    const review = res.body.review;
    if (!review) continue;
    sweep.push({ mod, rec, review, reason, title });
    createdIssueIds.push(review.id);
    check(`flag ${mod}: priority stored HIGH`, review.priority === "HIGH");
    check(`flag ${mod}: assigned to the worker`, Number(res.body.assignedTo?.id) === assignee.user.id);
    check(`flag ${mod}: pipeline opens actionable`, ["FLAGGED", "CORRECTION_REQUIRED", "OPEN"].includes(review.status));
  }
  check("module sweep flags created", sweep.length >= 4, String(sweep.length));

  // First sweep issue carries the deep content assertions.
  const s0 = sweep[0];
  if (s0) {
    const a = await notifsFor(assignee.token, s0.review.id);
    const n = a.rows.find((r) => r.type === "AUDIT_ISSUE_ASSIGNED");
    check("content: assignee got AUDIT Issue Assigned bell", !!n);
    if (n) {
      check("content: title carries priority + item", n.title.includes("HIGH") && n.title.includes(s0.title), n.title);
      check("content: body carries the auditor's reason", (n.body || "").includes(s0.reason));
      check("content: body names the auditor + business + branch", (n.body || "").includes(`Flagged by ${kwame.user.name}`) && (n.body || "").includes("Business:") && (n.body || "").includes("Branch:"), n.body);
      check("content: body states the required action", /required action:/i.test(n.body || ""));
      check("content: priority column carried to the bell", n.priority === "HIGH");
      check("content: tenant stamp (ownerId) attached", Number(n.ownerId) === 1, String(n.ownerId));
      check("content: record ref attached", (n.recordRef || "") === (s0.review.recordRef || ""), `${n.recordRef} vs ${s0.review.recordRef}`);
    }
    // Managers always watch; the OWNER here is the actor ⇒ excluded.
    const gm = await notifsFor(abena.token, s0.review.id);
    check("routing: org-1 GENERAL_MANAGER watches the flag", gm.rows.some((r) => r.type === "AUDIT_ISSUE_WATCH"));
    const own = await notifsFor(kwame.token, s0.review.id);
    check("routing: actor-Owner is NOT self-notified", own.rows.length === 0, `${own.rows.length} rows`);
  }

  // ── B) Severity routing through a non-Owner auditor ─────────────────────
  // HIGH → Owner escalated; MEDIUM → Owner NOT notified.
  const hi = finRec && await flag(auditor.token, finRec, { issueTitle: `AU ${R} severity HIGH`, reason: `High reason ${R}`, priority: "HIGH", assignedUserId: assignee.user.id });
  check("severity: auditor can flag inside grant", !!hi && hi.status === 200 && hi.body.success === true, hi ? JSON.stringify(hi.body).slice(0, 120) : "no rec");
  if (hi?.body?.review) {
    const j = hi.body.review; createdIssueIds.push(j.id);
    const own = await notifsFor(kwame.token, j.id);
    check("severity: HIGH escalates to the org Owner", own.rows.some((r) => r.type === "AUDIT_ISSUE_WATCH" && String(r.priority).toUpperCase() === "HIGH"));
    const agm = await notifsFor(abena.token, j.id);
    check("severity: HIGH also reaches managers", agm.rows.some((r) => r.type === "AUDIT_ISSUE_WATCH"));
    const self = await notifsFor(auditor.token, j.id);
    check("severity: auditor is never self-notified", self.rows.length === 0);
    const a = await notifsFor(assignee.token, j.id);
    check("severity: HIGH still reaches the assignee", a.rows.some((r) => r.type === "AUDIT_ISSUE_ASSIGNED"));
  }
  const med = finRec && await flag(auditor.token, finRec, { issueTitle: `AU ${R} severity MEDIUM`, reason: `Medium reason ${R}`, assignedUserId: assignee.user.id });
  if (med?.body?.review) {
    const j = med.body.review; createdIssueIds.push(j.id);
    check("severity: absent priority coerces to MEDIUM", j.priority === "MEDIUM", j.priority);
    const own = await notifsFor(kwame.token, j.id);
    check("severity: MEDIUM does NOT disturb the Owner", own.rows.length === 0, `${own.rows.length} rows`);
    const agm = await notifsFor(abena.token, j.id);
    check("severity: MEDIUM still reaches business managers", agm.rows.some((r) => r.type === "AUDIT_ISSUE_WATCH"));
  }
  const bogus = finRec && await flag(auditor.token, finRec, { issueTitle: `AU ${R} bogus priority`, reason: `Bogus priority ${R}`, priority: "URGENT", assignedUserId: assignee.user.id });
  if (bogus?.body?.review) {
    createdIssueIds.push(bogus.body.review.id);
    check("validation: unknown priority falls back to MEDIUM", bogus.body.review.priority === "MEDIUM", bogus.body.review.priority);
  }

  // ── C) Tenant isolation ─────────────────────────────────────────────────
  const cross = finRec && await flag(auditor.token, finRec, { issueTitle: `AU ${R} cross-org assign`, reason: `Cross org ${R}`, priority: "CRITICAL", assignedUserId: twinId });
  check("isolation: cross-org explicit assignee refused (twin not bound)", !!cross && cross.status === 200 && Number(cross.body.assignedTo?.id || 0) !== Number(twinId), cross ? JSON.stringify(cross.body.assignedTo) : "n/a");
  if (cross?.body?.review) {
    const j = cross.body.review; createdIssueIds.push(j.id);
    // CRITICAL pulls the org Owner into the watch list — UNLESS the Owner
    // legitimately IS the resolved assignee (no duplicate pings by design).
    const ownerIsAssignee = Number(cross.body.assignedTo?.id || 0) === kwame.user.id;
    const ownerWatch = (await notifsFor(kwame.token, j.id)).rows.some((r) => r.type === "AUDIT_ISSUE_WATCH");
    check("isolation: CRITICAL escalation reaches the Owner unless the Owner IS the assignee", ownerWatch === !ownerIsAssignee, `watch=${ownerWatch} ownerAssignee=${ownerIsAssignee}`);
    check("isolation: twin (foreign org) got nothing", (await notifsFor(twin.token, j.id)).rows.length === 0);
    check("isolation: unrelated Owner got nothing", (await notifsFor(ownerB.token, j.id)).rows.length === 0);
  }
  // Legacy workerName path: employee shares a display name ONLY with a
  // user in the UNRELATED org — nobody in org 1 must bind, and the twin
  // must not see/act on the issue.
  const empRes = await post(kwame.token, "/api/employees", { name: TWIN_NAME, role: "Casual", businessId: MAIN_BIZ.id, salaryGhs: 150 });
  const empId = empRes.body?.employee?.id ?? empRes.body?.id;
  check("isolation fixture: employee with twin's display name created", !!empId, JSON.stringify(empRes.body).slice(0, 120));
  if (empId) {
    const empRec = { recordType: "EMPLOYEE", recordSource: null, recordId: empId, module: "EMPLOYEES", businessId: MAIN_BIZ.id };
    const tri = await flag(auditor.token, empRec, { issueTitle: `AU ${R} twin-name legacy`, reason: `Twin name case ${R}`, priority: "MEDIUM" });
    check("isolation: twin-name flag created (no explicit assignee)", tri.status === 200 && tri.body.success === true, JSON.stringify(tri.body).slice(0, 120));
    if (tri.body?.review) {
      const j = tri.body.review; createdIssueIds.push(j.id);
      check("isolation: name-match did NOT bind the foreign twin", Number(tri.body.review.assignedUserId || 0) !== Number(twinId), `assignedUserId=${tri.body.review.assignedUserId}`);
      check("isolation: unassigned flag escalates to the Owner", (await notifsFor(kwame.token, j.id)).rows.some((r) => r.type === "AUDIT_ISSUE_WATCH"));
      const mine = await get(twin.token, "/api/audit/issues");
      check("isolation: twin's My-Issues excludes the org-1 issue", !(mine.body.issues || []).some((i) => Number(i.id) === Number(j.id)));
      const tResp = await post(twin.token, "/api/audit/issues", { action: "RESPOND", issueId: j.id, note: "twin try" });
      check("isolation: twin cannot respond to the org-1 issue", tResp.status === 403, `HTTP ${tResp.status}`);
      const tCount = await get(twin.token, "/api/notifications");
      check("isolation: twin openAssignedCount ignores org-1", (tCount.body.openAssignedCount || 0) === 0, String(tCount.body.openAssignedCount));
    }
  }

  // ── D) Read tracking ────────────────────────────────────────────────────
  if (s0) {
    const before = await notifsFor(assignee.token, s0.review.id);
    const n = before.rows.find((r) => r.type === "AUDIT_ISSUE_ASSIGNED");
    const marked = await patch(assignee.token, "/api/notifications", { ids: [n.id] });
    check("read: PATCH marks exactly the requested ids", marked.body.marked === 1, JSON.stringify(marked.body));
    const after = await notifsFor(assignee.token, s0.review.id);
    check("read: the row flipped to read", after.rows.find((r) => r.id === n.id)?.isRead === true);
    const gm = await notifsFor(abena.token, s0.review.id);
    check("read: other actors' copies stay unread", gm.rows.every((r) => r.isRead !== true), JSON.stringify(gm.rows.map((r) => r.isRead)));
  }

  // ── E) Full lifecycle: RESPOND → MARK_RESOLVED → VERIFY ─────────────────
  const life = finRec && await flag(auditor.token, finRec, { issueTitle: `AU ${R} lifecycle`, reason: `Lifecycle reason ${R}`, priority: "CRITICAL", assignedUserId: assignee.user.id });
  const L = life?.body?.review;
  check("lifecycle: issue created for the run", !!L);
  if (L) {
    createdIssueIds.push(L.id);
    const oaOpen = (await get(assignee.token, "/api/notifications")).body.openAssignedCount || 0;
    check("lifecycle: issue counts as open work on the bell", oaOpen >= 1, String(oaOpen));

    const resp = await post(assignee.token, "/api/audit/issues", { action: "RESPOND", issueId: L.id, note: `Response note ${R}` });
    check("lifecycle: RESPOND succeeds", resp.status === 200 && resp.body.success === true, JSON.stringify(resp.body).slice(0, 120));
    check("lifecycle: status → UNDER_REVIEW", resp.body.review?.status === "UNDER_REVIEW", resp.body.review?.status);
    const rev1 = await notifsFor(auditor.token, L.id);
    check("lifecycle: reviewer notified of the response", rev1.rows.some((r) => r.type === "AUDIT_ISSUE_RESPONSE" && r.isRead === false));

    const res2 = await post(assignee.token, "/api/audit/issues", { action: "MARK_RESOLVED", issueId: L.id, note: `Fixed it ${R}` });
    check("lifecycle: MARK_RESOLVED succeeds", res2.status === 200 && res2.body.success === true, JSON.stringify(res2.body).slice(0, 120));
    check("lifecycle: status → RESOLVED", res2.body.review?.status === "RESOLVED", res2.body.review?.status);
    const rev2 = await notifsFor(auditor.token, L.id);
    const freshResolved = rev2.rows.find((r) => r.type === "AUDIT_ISSUE_RESOLVED");
    check("lifecycle: reviewer gets the fresh resolved action item (unread)", !!freshResolved && freshResolved.isRead === false, JSON.stringify(rev2.rows.map((r) => [r.type, r.isRead])));
    check("lifecycle: reviewer's earlier response-notice retired to read", rev2.rows.filter((r) => r.type !== "AUDIT_ISSUE_RESOLVED").every((r) => r.isRead === true));
    const asg2 = await notifsFor(assignee.token, L.id);
    check("lifecycle: assignee's assignment notice retired on resolution", asg2.rows.every((r) => r.isRead === true), JSON.stringify(asg2.rows.map((r) => [r.type, r.isRead])));
    const gm2 = await notifsFor(abena.token, L.id);
    check("lifecycle: manager watch notice retired on resolution", gm2.rows.every((r) => r.isRead === true));
    const own2 = await notifsFor(kwame.token, L.id);
    check("lifecycle: Owner escalation notice retired on resolution", own2.rows.length > 0 && own2.rows.every((r) => r.isRead === true));
    const oaAfter = (await get(assignee.token, "/api/notifications")).body.openAssignedCount || 0;
    check("lifecycle: resolved issue no longer counts as open work", oaAfter === oaOpen - 1, `${oaOpen} → ${oaAfter}`);

    const ver = await patch(auditor.token, "/api/audit", { action: "VERIFY", reviewId: L.id, resolution: `Verified closed ${R}` });
    check("lifecycle: VERIFY closes the issue", ver.status === 200 && ver.body.success === true && ver.body.review?.status === "VERIFIED", JSON.stringify(ver.body).slice(0, 120));
    const rev3 = await notifsFor(auditor.token, L.id);
    check("lifecycle: reviewer's resolved-item retired after verify", rev3.rows.every((r) => r.isRead === true));
    const asg3 = await notifsFor(assignee.token, L.id);
    check("lifecycle: assignee gets the final closed notice (unread)", asg3.rows.some((r) => r.type === "AUDIT_ISSUE_VERIFIED" && r.isRead === false), JSON.stringify(asg3.rows.map((r) => [r.type, r.isRead])));
    const again = await post(assignee.token, "/api/audit/issues", { action: "RESPOND", issueId: L.id, note: "too late" });
    check("lifecycle: closed issue refuses further responses", again.status === 400, `HTTP ${again.status}`);
    const verAgain = await patch(auditor.token, "/api/audit", { action: "VERIFY", reviewId: L.id, resolution: "dup" });
    check("lifecycle: closed issue refuses re-verification", verAgain.status === 400, `HTTP ${verAgain.status}`);
  }

  // ── Global isolation sweep ──────────────────────────────────────────────
  const twinAll = await get(twin.token, "/api/notifications");
  const ownerBAll = await get(ownerB.token, "/api/notifications");
  const leak1 = (twinAll.body.notifications || []).filter((n) => createdIssueIds.includes(Number(n.issueId)));
  const leak2 = (ownerBAll.body.notifications || []).filter((n) => createdIssueIds.includes(Number(n.issueId)));
  check("global: unrelated tenant NEVER received any suite issue", leak1.length === 0 && leak2.length === 0, `${leak1.length + leak2.length} leaks`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await fixtureCleanup();
  if (fails.length) { console.log("Failures:\n - " + fails.join("\n - ")); process.exit(1); }
}

// H3: self-clean by default — suite fixtures (AU @demo.local users, AU Unrelated
// Org, "Unrelated Biz …") never linger in the demo tenant; KEEP=1 for forensics.
async function fixtureCleanup() {
  if (process.env.KEEP === "1") { console.log("KEEP=1 — fixtures retained."); return; }
  try {
    const { createRequire } = await import("module");
    const require2 = createRequire("/home/user/pgtooling/package.json");
    const { Client } = require2("pg");
    const { purgeByPatterns } = await import("./lib/fixture-purge.mjs");
    const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
    await pg.connect();
    const out = await purgeByPatterns(pg, {});
    await pg.end();
    console.log(`self-clean: purged organizations=${out.organizations} users=${out.users} businesses=${out.businesses} notifications=${out.notifications}`);
  } catch (e) { console.log("self-clean failed (non-fatal):", String(e).slice(0, 120)); }
}

main().catch(async (e) => { console.error("FATAL", e); await fixtureCleanup(); process.exit(1); });
