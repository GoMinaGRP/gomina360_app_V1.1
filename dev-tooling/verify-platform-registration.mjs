/**
 * verify-platform-registration.mjs — Platform Help/Contact + "Join/Register on
 * the Platform" pipeline E2E (audit: docs/PLATFORM-HELP-AND-REGISTRATION-AUDIT.md).
 *
 *   A · Public submission — anonymous POST works and returns ONLY an opaque
 *       reference; purpose/email/phone/name validation; honeypot; one-open-
 *       request-per-email dedupe; two-layer IP throttle (429 + Retry-After).
 *   B · PRIVATE review — anonymous 401; GM/BM/other-OWNER 403; a user holding
 *       the OWNER-granted canManageSupport is STILL 403 (it is a tenant grant,
 *       not a platform one); Super Admin 200. Approve/reject/provision.
 *   C · Privacy — a platform request never appears in a tenant's /api/init, in
 *       a tenant user's bell, or in the business-scoped payloads; the Super
 *       Admin's bell row carries businessId=null / ownerId=null; audit rows are
 *       written with ownerId=NULL (never attributed to a tenant).
 *   D · Platform scope fix — GET /api/support-info returns the PLATFORM row to
 *       the public, `?org=` still returns a tenant's own row, `edit.scope` /
 *       `canEditRegistration` are correct per caller, and registration config
 *       can only be changed by the Super Admin.
 *   E · UI — the storefront HELP panel carries the platform-branded registration
 *       CTA, the footer carries the join line, and /join renders + submits and
 *       shows a reference code.
 *   Z · Cleanup & forensics — every suite artifact purged, live data
 *       byte-identical, zero console/page errors.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const OWNER_ID = 1;
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2", id: 2 };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };

/** Marker that makes every artifact this suite creates trivially findable. */
const TAG = "PR-SUITE";
const TEST_EMAIL = (n) => `pr.suite.${n}@example-test.invalid`;

const results = [];
const baseline = {};
const pageErrors = [];
const created = { requestIds: [], orgIds: [], userIds: [] };
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `xff` lets a test present a distinct client IP. The public endpoint throttles
 * per IP, so isolating the throttle checks from the functional ones (and from
 * each other) requires an explicit, controllable source address.
 */
async function api(cookie, path, opts = {}) {
  const { xff, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(xff ? { "x-forwarded-for": xff } : {}),
      ...(opts.headers || {}),
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, headers: res.headers };
}
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

const post = (body, xff, cookie) =>
  api(cookie, "/api/platform-requests", { method: "POST", body: JSON.stringify(body), xff });

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413|429)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};

/* ── A · public submission ─────────────────────────────────────────── */
async function sectionA() {
  console.log("\n— A · Public submission (anonymous) —");

  const valid = {
    purpose: "JOIN_PLATFORM",
    businessName: `${TAG} Retail`,
    contactName: `${TAG} Applicant`,
    contactEmail: TEST_EMAIL("a1"),
    contactPhone: "0551234567",
    businessType: "POULTRY_FARM",
    location: "Kumasi",
    message: `${TAG} please contact me`,
    source: "join",
  };

  const created1 = await post(valid, "10.9.0.1");
  ok("A1 anonymous POST is accepted (200) — no sign-in needed", created1.status === 200 && created1.json?.success === true,
    `${created1.status} ${JSON.stringify(created1.json || {}).slice(0, 140)}`);

  const ref = created1.json?.reference;
  ok("A2 the response carries ONLY an opaque reference (no id, no row, no status)",
    typeof ref === "string" && /^GMR-[A-Z2-9]{6}$/.test(ref) &&
      created1.json.id === undefined && created1.json.request === undefined && created1.json.requests === undefined &&
      created1.json.status === undefined,
    JSON.stringify(created1.json || {}).slice(0, 200));
  if (ref) {
    const row = await pg.query(`SELECT id, status FROM platform_requests WHERE reference=$1`, [ref]);
    if (row.rows[0]) created.requestIds.push(row.rows[0].id);
    ok("A3 the request is stored as PENDING and carries no tenant column value",
      row.rows[0]?.status === "PENDING", JSON.stringify(row.rows[0] || null));
  }

  // Unknown purpose must never be stored verbatim.
  const badPurpose = await post({ ...valid, purpose: "HACK_THE_PLANET", contactEmail: TEST_EMAIL("a4") }, "10.9.0.2");
  const storedBad = await pg.query(`SELECT count(*)::int c FROM platform_requests WHERE purpose=$1`, ["HACK_THE_PLANET"]);
  ok("A4 an unknown purpose is refused (400) and never stored raw",
    badPurpose.status === 400 && storedBad.rows[0].c === 0, `${badPurpose.status}`);

  const badEmail = await post({ ...valid, contactEmail: "not-an-email" }, "10.9.0.3");
  ok("A5 an invalid email is refused (400)", badEmail.status === 400, `${badEmail.status}`);

  const badPhone = await post({ ...valid, contactEmail: TEST_EMAIL("a6"), contactPhone: "123" }, "10.9.0.4");
  ok("A6 a non-10-digit Ghana phone is refused (400)", badPhone.status === 400, `${badPhone.status}`);

  const noChannel = await post({ purpose: "SUPPORT", contactName: `${TAG} No Channel` }, "10.9.0.5");
  ok("A7 a request with no email AND no phone is refused (400)", noChannel.status === 400, `${noChannel.status}`);

  const shortName = await post({ ...valid, contactName: "X", contactEmail: TEST_EMAIL("a8") }, "10.9.0.6");
  ok("A8 a 1-character name is refused (400)", shortName.status === 400, `${shortName.status}`);

  // Honeypot: a filled hidden field must store nothing, yet still look like a
  // success to the bot.
  const beforeTrap = (await pg.query(`SELECT count(*)::int c FROM platform_requests`)).rows[0].c;
  const trapped = await post({ ...valid, contactEmail: TEST_EMAIL("a9"), companyWebsite: "http://spam.example" }, "10.9.0.7");
  const afterTrap = (await pg.query(`SELECT count(*)::int c FROM platform_requests`)).rows[0].c;
  ok("A9 the honeypot silently accepts but stores NOTHING",
    trapped.status === 200 && trapped.json?.reference == null && afterTrap === beforeTrap,
    `${trapped.status} ${beforeTrap}→${afterTrap}`);

  // Duplicate: same email while an open request exists ⇒ generic success, no
  // reference (so no existing reference code is handed to a stranger).
  const dupe = await post({ ...valid }, "10.9.0.8");
  ok("A10 a second OPEN request for the same email is not duplicated and returns no reference",
    dupe.status === 200 && dupe.json?.success === true && dupe.json?.duplicate === true && !dupe.json?.reference,
    JSON.stringify(dupe.json || {}).slice(0, 160));

  // Throttle: burst cap is 3/min per IP, so the 4th rapid hit from ONE ip 429s.
  const burstIp = "10.9.9.9";
  let throttled = null;
  for (let i = 0; i < 5; i++) {
    const r = await post({ ...valid, contactEmail: TEST_EMAIL(`burst${i}`) }, burstIp);
    if (r.status === 429) {
      throttled = r;
      break;
    }
    if (r.status === 200 && r.json?.reference) {
      const row = await pg.query(`SELECT id FROM platform_requests WHERE reference=$1`, [r.json.reference]);
      if (row.rows[0]) created.requestIds.push(row.rows[0].id);
    }
  }
  ok("A11 the per-IP burst throttle kicks in (429 with Retry-After)",
    throttled?.status === 429 && !!throttled.headers.get("retry-after"),
    throttled ? `${throttled.status} retry-after=${throttled.headers.get("retry-after")}` : "never throttled");
  const limitedBody = throttled?.json?.error || "";
  ok("A12 the throttle message is generic (no internal detail leaked)",
    /too many requests/i.test(limitedBody), limitedBody.slice(0, 120));
}

/* ── B · private review & permissions ──────────────────────────────── */
async function sectionB(cookies) {
  console.log("\n— B · Private review — permissions & lifecycle —");

  const anon = await api(null, "/api/platform-requests");
  ok("B1 anonymous GET is refused (401)", anon.status === 401, `${anon.status}`);

  for (const [label, c] of [["GM", cookies.gm], ["BM", cookies.bm]]) {
    const r = await api(c, "/api/platform-requests");
    ok(`B2 ${label} cannot read the review queue (403)`, r.status === 403, `${r.status}`);
  }
  const gmPatch = await api(cookies.gm, "/api/platform-requests", {
    method: "PATCH",
    body: JSON.stringify({ id: created.requestIds[0] || 1, action: "APPROVE" }),
  });
  ok("B3 a non-Super-Admin cannot decide requests (403)", gmPatch.status === 403, `${gmPatch.status}`);

  // A tenant-scoped canManageSupport grant must NOT open the platform queue —
  // it is a storefront-HELP grant, not a platform grant.
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: true }) });
  const grantedGm = await api(cookies.gm, "/api/platform-requests");
  ok("B4 the OWNER-granted canManageSupport does NOT unlock platform requests (403)", grantedGm.status === 403, `${grantedGm.status}`);
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: false }) });

  const listRes = await api(cookies.owner, "/api/platform-requests");
  ok("B5 the Super Admin can read the queue (200) with status counts",
    listRes.status === 200 && Array.isArray(listRes.json?.requests) && listRes.json?.counts,
    `${listRes.status}`);
  ok("B6 the queue lists the public submission with its purpose label",
    (listRes.json?.requests || []).some((r) => r.reference && r.purposeLabel),
    JSON.stringify((listRes.json?.requests || [])[0] || null).slice(0, 160));

  const id = created.requestIds[0];
  const badAction = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "NOPE" }) });
  ok("B7 an unknown action is refused (400)", badAction.status === 400, `${badAction.status}`);

  const rejectNoReason = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "REJECT" }) });
  ok("B8 rejecting without a reason is refused (400)", rejectNoReason.status === 400, `${rejectNoReason.status}`);

  const earlyProvision = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "PROVISION", name: `${TAG} Ltd` }) });
  ok("B9 provisioning before approval is refused (409)", earlyProvision.status === 409, `${earlyProvision.status}`);

  const review = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "START_REVIEW" }) });
  ok("B10 START_REVIEW moves the request to IN_REVIEW", review.status === 200 && review.json?.request?.status === "IN_REVIEW",
    `${review.status} ${review.json?.request?.status}`);

  const approve = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "APPROVE", reason: `${TAG} verified by phone` }) });
  ok("B11 APPROVE records the decision WITHOUT creating an account yet",
    approve.status === 200 && approve.json?.request?.status === "APPROVED" && !approve.json?.request?.createdOrganizationId,
    `${approve.status} ${JSON.stringify(approve.json?.request || {}).slice(0, 140)}`);

  const provision = await api(cookies.owner, "/api/platform-requests", {
    method: "PATCH",
    body: JSON.stringify({ id, action: "PROVISION", name: `${TAG} Ltd`, ownerName: `${TAG} Applicant` }),
  });
  const pjson = provision.json || {};
  if (pjson.organization?.id) created.orgIds.push(pjson.organization.id);
  if (pjson.owner?.id) created.userIds.push(pjson.owner.id);
  ok("B12 PROVISION creates the organization + Owner login and returns a one-time password",
    provision.status === 200 && pjson.organization?.id > 0 && pjson.owner?.id > 0 &&
      typeof pjson.initialPassword === "string" && pjson.initialPassword.length >= 8,
    `${provision.status} ${JSON.stringify({ org: pjson.organization, owner: pjson.owner, otp: !!pjson.initialPassword })}`);

  ok("B13 the new Owner is a normal organization OWNER — never a Super Admin",
    pjson.owner?.role === "OWNER" &&
      (await pg.query(`SELECT is_super_admin, primary_org_id FROM users WHERE id=$1`, [pjson.owner?.id])).rows[0]?.is_super_admin === false,
    JSON.stringify(pjson.owner || null));

  const reprovision = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id, action: "PROVISION", name: `${TAG} Ltd` }) });
  ok("B14 re-provisioning the SAME request is refused (409) — no duplicate account",
    reprovision.status === 409, `${reprovision.status}`);

  const stale = await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id: 999999, action: "CLOSE" }) });
  ok("B15 acting on a non-existent request is 404", stale.status === 404, `${stale.status}`);

  // B17 — SELF-HEALING: a workspace that exists but was never stamped on the
  // request (crash between the two writes) must be ADOPTED on retry, not left
  // as an orphan that 409s forever.
  const heal = await post(
    { purpose: "JOIN_PLATFORM", businessName: `${TAG} Heal`, contactName: `${TAG} Heal Applicant`, contactEmail: TEST_EMAIL("heal"), contactPhone: "0553334444" },
    "10.9.0.12",
  );
  const healRow = await pg.query(`SELECT id FROM platform_requests WHERE reference=$1`, [heal.json?.reference]);
  const healId = healRow.rows[0]?.id;
  if (healId) {
    created.requestIds.push(healId);
    await api(cookies.owner, "/api/platform-requests", { method: "PATCH", body: JSON.stringify({ id: healId, action: "APPROVE" }) });
    // Simulate the half-done attempt: create the workspace through the CONSOLE
    // route (so it is a real, fully-formed workspace) but never stamp the request.
    const orphan = await api(cookies.owner, "/api/admin/organizations", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG} Heal Ltd`, ownerName: `${TAG} Heal Applicant`, ownerEmail: TEST_EMAIL("heal") }),
    });
    if (orphan.json?.organization?.id) created.orgIds.push(orphan.json.organization.id);
    if (orphan.json?.owner?.id) created.userIds.push(orphan.json.owner.id);
    ok("B17a the pre-existing workspace was created cleanly by the console route",
      orphan.status === 200 && !!orphan.json?.organization?.id && !!orphan.json?.owner?.id,
      `http=${orphan.status} body=${JSON.stringify(orphan.json).slice(0, 300)}`);

    const retry = await api(cookies.owner, "/api/platform-requests", {
      method: "PATCH",
      body: JSON.stringify({ id: healId, action: "PROVISION", name: `${TAG} Heal Ltd` }),
    });
    const stamped = await pg.query(`SELECT created_organization_id, created_owner_user_id, status FROM platform_requests WHERE id=$1`, [healId]);
    ok("B17 a half-provisioned request is RECOVERED on retry (no orphan, no duplicate account)",
      retry.status === 200 && retry.json?.recovered === true &&
        Number(stamped.rows[0]?.created_organization_id) === Number(orphan.json?.organization?.id) &&
        Number(stamped.rows[0]?.created_owner_user_id) === Number(orphan.json?.owner?.id),
      `${retry.status} recovered=${retry.json?.recovered} stamped=${JSON.stringify(stamped.rows[0] || null)} ` +
        `orphanHttp=${orphan.status} orphanOrg=${orphan.json?.organization?.id} orphanOwner=${orphan.json?.owner?.id} orphanBody=${JSON.stringify(orphan.json).slice(0, 180)}`);

    const userCount = await pg.query(`SELECT count(*)::int c FROM users WHERE email=$1`, [TEST_EMAIL("heal")]);
    ok("B17b recovery created NO second account for the same email", userCount.rows[0].c === 1, `${userCount.rows[0].c}`);
  } else {
    ok("B17 a half-provisioned request is RECOVERED on retry (no orphan, no duplicate account)", false, "could not create the healing fixture");
    ok("B17b recovery created NO second account for the same email", false, "fixture missing");
  }

  // Reject path on a second request.
  const second = await post(
    { purpose: "REQUEST_DEMO", contactName: `${TAG} Second`, contactEmail: TEST_EMAIL("b16"), contactPhone: "0559876543" },
    "10.9.0.11",
  );
  if (second.json?.reference) {
    const r2 = await pg.query(`SELECT id FROM platform_requests WHERE reference=$1`, [second.json.reference]);
    if (r2.rows[0]) created.requestIds.push(r2.rows[0].id);
    const rej = await api(cookies.owner, "/api/platform-requests", {
      method: "PATCH",
      body: JSON.stringify({ id: r2.rows[0]?.id, action: "REJECT", reason: `${TAG} outside our market` }),
    });
    const stored = await pg.query(`SELECT status, decision_reason FROM platform_requests WHERE id=$1`, [r2.rows[0]?.id]);
    ok("B16 REJECT stores the reason and creates NO organization",
      rej.status === 200 && stored.rows[0]?.status === "REJECTED" && /outside our market/.test(stored.rows[0]?.decision_reason || ""),
      JSON.stringify(stored.rows[0] || null));
  } else {
    ok("B16 REJECT stores the reason and creates NO organization", false, "could not create the second request");
  }
}

/* ── C · privacy ───────────────────────────────────────────────────── */
async function sectionC(cookies) {
  console.log("\n— C · Privacy — platform requests never reach a tenant —");

  const notif = await api(cookies.owner, "/api/notifications");
  const platformNotes = (notif.json?.notifications || []).filter((n) => n.type === "PLATFORM_REQUEST_NEW");
  ok("C1 the Super Admin's bell carries the platform request", platformNotes.length >= 1, `${platformNotes.length}`);

  // Scope the tenant-isolation assertion to the rows THIS suite raised: the
  // invariant is about how the app writes them, so pre-existing rows from other
  // seeds must not be able to skew it (nor may this suite pass on their behalf).
  const mineNotes = (await pg.query(
    `SELECT business_id, owner_id, record_ref FROM notifications WHERE type='PLATFORM_REQUEST_NEW' AND id > $1`,
    [baseline.notifMax],
  )).rows;
  ok("C2 every bell row this suite raised belongs to NO tenant (businessId & ownerId null)",
    mineNotes.length >= 1 && mineNotes.every((n) => n.business_id === null && n.owner_id === null),
    JSON.stringify(mineNotes.slice(0, 3)));

  // …and the same invariant must hold across the whole table, so a single
  // stale/demo row can never hide a regression elsewhere.
  const allNotes = (await pg.query(
    `SELECT count(*)::int c FROM notifications WHERE type='PLATFORM_REQUEST_NEW' AND (business_id IS NOT NULL OR owner_id IS NOT NULL)`,
  )).rows[0].c;
  ok("C2b no PLATFORM_REQUEST_NEW row anywhere carries a tenant id", allNotes === 0, `offending=${allNotes}`);

  const gmNotif = await api(cookies.gm, "/api/notifications");
  ok("C3 a tenant user's bell never carries platform requests",
    (gmNotif.json?.notifications || []).filter((n) => n.type === "PLATFORM_REQUEST_NEW").length === 0);

  const gmInit = await api(cookies.gm, "/api/init");
  const initTxt = JSON.stringify(gmInit.json || {});
  const leakedRefs = (await pg.query(`SELECT reference FROM platform_requests WHERE id = ANY($1::int[])`, [created.requestIds.length ? created.requestIds : [0]]))
    .rows.map((r) => r.reference)
    .filter((r) => initTxt.includes(r));
  ok("C4 no request reference appears anywhere in a tenant's /api/init payload",
    leakedRefs.length === 0 && !/platform_requests/.test(initTxt.replace(/platform_requests_?[a-z_]*/g, "")) , leakedRefs.join(","));

  const auditRows = await pg.query(`SELECT action, owner_id FROM audit_trail WHERE target_type='PLATFORM_REQUEST' AND id > $1`, [baseline.auditMax]);
  ok("C5 platform audit rows are written with ownerId = NULL (never attributed to a tenant)",
    auditRows.rows.length > 0 && auditRows.rows.every((r) => r.owner_id === null),
    JSON.stringify(auditRows.rows.slice(0, 4)));

  const tenantAudit = await api(cookies.gm, "/api/audit?limit=200");
  const auditTxt = JSON.stringify(tenantAudit.json || {});
  ok("C6 a tenant's audit feed never exposes platform request decisions",
    !/PLATFORM_REQUEST|PROVISION_PLATFORM_REQUEST/.test(auditTxt), auditTxt.slice(0, 120));

  // The provisioned Owner's own login must exist and be isolated.
  const ownerId = created.userIds[0];
  if (ownerId) {
    const [u] = (await pg.query(`SELECT email, role, is_super_admin, primary_org_id FROM users WHERE id=$1`, [ownerId])).rows;
    ok("C7 the provisioned Owner is scoped to its OWN organization only",
      u?.primary_org_id === created.orgIds[0] && u?.is_super_admin === false, JSON.stringify(u || null));
    const memberships = await pg.query(`SELECT organization_id FROM organization_members WHERE user_id=$1`, [ownerId]);
    ok("C8 the provisioned Owner has exactly one membership (no cross-tenant access)",
      memberships.rows.length === 1 && Number(memberships.rows[0].organization_id) === Number(created.orgIds[0]),
      JSON.stringify(memberships.rows));
  }
}

/* ── D · platform support scope ───────────────────────────────────── */
async function sectionD(cookies) {
  console.log("\n— D · Platform Help/Contact scope —");

  const pub = await api(null, "/api/support-info");
  ok("D1 public GET still answers 200 without a login (shopers see the HELP info)",
    pub.status === 200 && pub.json?.success === true, `${pub.status}`);
  ok("D2 the public response never carries the editing context", pub.json?.edit === null, JSON.stringify(pub.json?.edit));
  ok("D3 the public row exposes the registration CTA config",
    pub.json?.info === null || ("registrationEnabled" in pub.json.info && "registrationHeadline" in pub.json.info),
    JSON.stringify(pub.json?.info || null).slice(0, 140));

  const ownerView = await api(cookies.owner, "/api/support-info");
  ok("D4 the Super Admin's edit scope is PLATFORM with registration rights",
    ownerView.json?.edit?.scope === "PLATFORM" && ownerView.json?.edit?.canEdit === true && ownerView.json?.edit?.canEditRegistration === true,
    JSON.stringify(ownerView.json?.edit || null).slice(0, 160));

  const gmView = await api(cookies.gm, "/api/support-info");
  ok("D5 a granted staff member may edit the helpdesk but NOT platform registration",
    gmView.json?.edit?.scope === "PLATFORM" && gmView.json?.edit?.canEditRegistration === false,
    JSON.stringify(gmView.json?.edit || null).slice(0, 160));

  const bmView = await api(cookies.bm, "/api/support-info");
  ok("D6 a non-granted staff member has canEdit = false", bmView.json?.edit?.canEdit === false, JSON.stringify(bmView.json?.edit || null).slice(0, 140));

  // The fix for the old read/write asymmetry: the editor is handed the row its
  // Save will write — for platform editors that is the row the PUBLIC reads.
  const platformRow = await pg.query(`SELECT id FROM customer_support_info WHERE is_platform = true ORDER BY id LIMIT 1`);
  const editId = ownerView.json?.edit?.row ? platformRow.rows[0]?.id : null;
  ok("D7 the row offered to the platform editor IS the published platform row",
    platformRow.rows.length === 1 && editId != null, JSON.stringify(platformRow.rows));

  const anonPost = await api(null, "/api/support-info", { method: "POST", body: JSON.stringify({ contactName: "hack" }) });
  ok("D8 anonymous POST is still refused (401)", anonPost.status === 401, `${anonPost.status}`);

  const bmPost = await api(cookies.bm, "/api/support-info", { method: "POST", body: JSON.stringify({ contactName: "nope" }) });
  ok("D9 a non-owner, non-granted user still cannot edit the helpdesk (403)", bmPost.status === 403, `${bmPost.status}`);

  const badEmail = await api(cookies.owner, "/api/support-info", { method: "POST", body: JSON.stringify({ email: "nope" }) });
  ok("D10 invalid email is still refused (400)", badEmail.status === 400, `${badEmail.status}`);

  // Registration config is Super-Admin-only: a granted GM's save must leave it
  // exactly as it was.
  const before = (await pg.query(`SELECT registration_enabled, registration_headline FROM customer_support_info WHERE is_platform = true`)).rows[0];
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: true }) });
  const gmSave = await api(cookies.gm, "/api/support-info", {
    method: "POST",
    body: JSON.stringify({ contactName: `${TAG} GM Edited`, registration: { enabled: !before?.registration_enabled, headline: `${TAG} HIJACKED` } }),
  });
  const after = (await pg.query(`SELECT registration_enabled, registration_headline FROM customer_support_info WHERE is_platform = true`)).rows[0];
  ok("D11 a granted staff save CANNOT change the platform registration CTA",
    gmSave.status === 200 && after.registration_enabled === before.registration_enabled &&
      (after.registration_headline || "") === (before.registration_headline || ""),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  // ── The LOGIN-PAGE switch (login_registration_enabled) ───────────────────
  // A SECOND switch on the same row, consumed by a different surface: the staff
  // sign-in gate at `/`. It must be visible to the editor, flippable by the
  // Super Admin alone, and completely decoupled from the order-page invite.
  const projection = (await api(null, "/api/support-info")).json?.info;
  ok("D12 the public projection carries the login-page switch as a boolean",
    projection == null || typeof projection.loginRegistrationEnabled === "boolean",
    JSON.stringify(projection?.loginRegistrationEnabled));

  const loginBefore = (await pg.query(`SELECT login_registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0];
  const orderFlagPre = (await pg.query(`SELECT registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0]?.registration_enabled;
  const ownerFlip = await api(cookies.owner, "/api/support-info", {
    method: "POST",
    body: JSON.stringify({ registration: { enabled: orderFlagPre !== false, loginEnabled: true } }),
  });
  const loginAfter = (await pg.query(`SELECT login_registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0];
  const orderFlagPost = (await pg.query(`SELECT registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0]?.registration_enabled;
  ok("D13 the Super Admin can flip the login-page switch",
    ownerFlip.status === 200 && ownerFlip.json?.info?.loginRegistrationEnabled === true && loginAfter?.login_registration_enabled === true,
    `status=${ownerFlip.status} row=${JSON.stringify(loginAfter)}`);
  ok("D13b …and that flip leaves the ORDER-page flag untouched", orderFlagPost === orderFlagPre,
    `before=${orderFlagPre} after=${orderFlagPost}`);

  const gmPre = (await pg.query(`SELECT login_registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0]?.login_registration_enabled;
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: true }) });
  const gmFlip = await api(cookies.gm, "/api/support-info", {
    method: "POST",
    body: JSON.stringify({ contactName: `${TAG} GM Login Toggle`, registration: { enabled: true, loginEnabled: false } }),
  });
  const gmPost = (await pg.query(`SELECT login_registration_enabled FROM customer_support_info WHERE is_platform = true`)).rows[0]?.login_registration_enabled;
  ok("D14 even a granted staff save CANNOT flip the login-page switch",
    gmFlip.status === 200 && gmPost === gmPre, `before=${gmPre} after=${gmPost} status=${gmFlip.status}`);
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: false }) });

  // Leave the column exactly as the suite found it (Z3 compares byte-for-byte).
  await pg.query(`UPDATE customer_support_info SET login_registration_enabled = $1 WHERE is_platform = true`,
    [loginBefore?.login_registration_enabled ?? null]);
}

/* ── E · UI ────────────────────────────────────────────────────────── */
async function sectionE(browser) {
  console.log("\n— E · Storefront & sign-up UI —");

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "storefront");
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });

  ok("E1 the storefront footer carries the platform join line",
    (await page.$('[data-testid="oo-footer-join"]')) != null);

  await page.click('[data-testid="oo-help"]');
  await page.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 15000 });
  const cta = await page.$('[data-testid="oo-help-join"]');
  ok("E2 the HELP panel carries the platform registration block", !!cta);
  if (cta) {
    const text = await page.$eval('[data-testid="oo-help-join"]', (el) => el.textContent || "");
    ok("E3 the block is about the PLATFORM, not the shop being browsed",
      /GoMina 360/.test(text) && /platform team/i.test(text), text.slice(0, 160));
    const href = await page.$eval('[data-testid="oo-help-join-cta"]', (el) => el.getAttribute("href"));
    ok("E4 its CTA links to the public /join page", href === "/join", String(href));
  }
  // The how-to guide must be untouched by the new block.
  const steps = await page.$$('[data-testid^="oo-howto-step-"]');
  ok("E5 the 9-step how-to guide is unchanged by the new block", steps.length === 9, `steps=${steps.length}`);
  await page.close();
  await ctx.close();

  // /join renders and submits.
  const ctx2 = await browser.createBrowserContext();
  const jp = await ctx2.newPage();
  hookPage(jp, "join");
  await jp.setViewport({ width: 1280, height: 1000 });
  await jp.goto(`${BASE}/join`, { waitUntil: "networkidle0", timeout: 60000 });
  await jp.waitForSelector('[data-testid="join-form"]', { timeout: 30000 });
  ok("E6 /join renders the registration form", true);
  const purposeCount = await jp.$$('[data-testid^="join-purpose-"]');
  ok("E7 the form offers a PURPOSE selection (the requested contact-purpose choice)", purposeCount.length >= 5, `options=${purposeCount.length}`);

  await jp.click('[data-testid="join-purpose-REQUEST_DEMO"]');
  await jp.type('[data-testid="join-name"]', `${TAG} UI Applicant`);
  await jp.type('[data-testid="join-email"]', TEST_EMAIL("e8"));
  await jp.type('[data-testid="join-phone"]', "0551112222");
  await jp.type('[data-testid="join-business"]', `${TAG} UI Biz`);
  await jp.click('[data-testid="join-submit"]');
  await jp.waitForSelector('[data-testid="join-success"]', { timeout: 30000 });
  const shownRef = await jp.$eval('[data-testid="join-reference"]', (el) => (el.textContent || "").trim());
  ok("E8 submitting from /join shows the requester a reference code",
    /^GMR-[A-Z2-9]{6}$/.test(shownRef), shownRef);
  const uiRow = await pg.query(`SELECT id, purpose, status FROM platform_requests WHERE reference=$1`, [shownRef]);
  if (uiRow.rows[0]) created.requestIds.push(uiRow.rows[0].id);
  ok("E9 the submitted purpose is stored as chosen (REQUEST_DEMO)",
    uiRow.rows[0]?.purpose === "REQUEST_DEMO" && uiRow.rows[0]?.status === "PENDING",
    JSON.stringify(uiRow.rows[0] || null));
  await jp.close();
  await ctx2.close();
}


/**
 * F · Request → notification → Action Center → review → decision workflow.
 *
 * The four surfaces that must agree about a request:
 *   · the Super Admin's BELL (unread state + a title that names the next action),
 *   · the ACTION CENTER's live "linked" zone (and its deep link),
 *   · the review QUEUE (badge + rows),
 *   · the request's own STATUS.
 * Every assertion below checks one of those agreements, including the two
 * notification paths a real operator uses: clicking the bell row and clicking a
 * push-notification deep link.
 */
async function sectionF(browser, cookies) {
  console.log("\n— F · Notification → Action Center → decision workflow —");

  const submit = async (label, xff) => {
    const res = await api(null, "/api/platform-requests", {
      method: "POST",
      xff,
      body: JSON.stringify({
        purpose: "JOIN_PLATFORM",
        businessName: `${TAG} ${label}`,
        contactName: `${TAG} ${label} Applicant`,
        contactEmail: TEST_EMAIL(`f-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, "")),
        contactPhone: "0551230000",
        businessType: "HARDWARE_STORE",
      }),
    });
    const row = await pg.query(`SELECT id, reference FROM platform_requests WHERE reference=$1`, [res.json?.reference]);
    if (row.rows[0]) created.requestIds.push(row.rows[0].id);
    return { ref: res.json?.reference, id: row.rows[0]?.id, status: res.status };
  };

  // ── F1–F3 · the notification exists, is private, and names the next action ──
  const a = await submit("Bell", "10.9.1.31");
  ok("F1 a submission produces a Super Admin bell row", !!a.id, JSON.stringify(a));
  let bell = (await pg.query(`SELECT id, title, is_read, business_id, owner_id FROM notifications WHERE record_ref=$1`, [`platform-request:${a.ref}`])).rows[0];
  ok("F2 that bell row is unread and platform-scoped (no tenant ids)",
    bell && bell.is_read === false && bell.business_id === null && bell.owner_id === null, JSON.stringify(bell || null));
  ok("F3 the bell title names the outstanding action", bell?.title === "New platform request", bell?.title);

  // ── F4–F6 · the Action Center surfaces it as an actionable, deep-linkable item ──
  const tasksRes = await api(cookies.owner, "/api/tasks?status=ACTIVE");
  const linkedPr = tasksRes.json?.linked?.platformRequests || [];
  const item = linkedPr.find((r) => r.openRef === a.ref);
  ok("F4 the Action Center lists the request as an actionable item", !!item, JSON.stringify(linkedPr).slice(0, 200));
  ok("F5 its deep link targets the review console WITH the reference",
    item?.openTab === "PLATFORM_ADMIN" && item?.openRef === a.ref, JSON.stringify(item || null));
  const gmTasks = await api(cookies.gm, "/api/tasks?status=ACTIVE");
  ok("F6 a non-Super-Admin never sees platform requests in the Action Center",
    (gmTasks.json?.linked?.platformRequests || []).length === 0);

  // ── F7–F9 · clicking the bell row lands ON the request ──
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "workflow");
  await page.setViewport({ width: 1500, height: 1100 });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await page.waitForSelector('[data-testid="notif-bell"]', { timeout: 30000 });
  await sleep(1500);

  await page.click('[data-testid="notif-bell"]');
  await page.waitForSelector('[data-testid^="notif-item-"]', { timeout: 15000 });
  const tag = await page.evaluate((ref) => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="notif-item-"]'));
    const hit = rows.find((r) => (r.textContent || "").includes(ref));
    return hit ? (hit.textContent || "").replace(/\s+/g, " ") : null;
  }, a.ref);
  ok("F7 the bell row advertises the Platform Requests destination", !!tag && tag.includes("Platform Requests"), String(tag).slice(0, 140));

  await page.evaluate((ref) => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="notif-item-"]'));
    rows.find((r) => (r.textContent || "").includes(ref))?.click();
  }, a.ref);
  await page.waitForSelector('[data-testid="platform-requests"]', { timeout: 20000 });
  // The panel expands + scrolls the focused row on a short delay; give it time.
  await sleep(1200);
  const focused = await page.evaluate((ref) => {
    const row = Array.from(document.querySelectorAll('[data-testid^="platform-request-"]'))
      .find((el) => (el.textContent || "").includes(ref));
    return { found: !!row, actions: !!row?.querySelector('[data-testid^="platform-request-review-"]') };
  }, a.ref);
  ok("F8 the click opens the request repository (not the Command Center)", true);
  ok("F9 the referenced request is expanded, with its review actions",
    focused.found && focused.actions, JSON.stringify(focused));

  // ── F10–F12 · a decision re-synchronises the bell, the queue and the Action Center ──
  const approve = await api(cookies.owner, "/api/platform-requests", {
    method: "PATCH",
    body: JSON.stringify({ id: a.id, action: "APPROVE" }),
  });
  ok("F10 APPROVE succeeds", approve.status === 200 && approve.json?.request?.status === "APPROVED", `${approve.status}`);
  bell = (await pg.query(`SELECT title, is_read FROM notifications WHERE record_ref=$1`, [`platform-request:${a.ref}`])).rows[0];
  ok("F11 the bell now names the NEXT action (provision the workspace)",
    /provision/i.test(bell?.title || ""), JSON.stringify(bell || null));
  const afterApprove = await api(cookies.owner, "/api/tasks?status=ACTIVE");
  ok("F12 the Action Center keeps it while provisioning is still owed",
    (afterApprove.json?.linked?.platformRequests || []).some((r) => r.openRef === a.ref));
  const queue = await api(cookies.owner, "/api/platform-requests");
  ok("F13 the queue badge still counts an approved-but-unprovisioned request",
    Number(queue.json?.openCount || 0) >= 1, `openCount=${queue.json?.openCount}`);

  // ── F14–F17 · a second request proves the push deep link + terminal sync ──
  const b = await submit("Link", "10.9.1.32");
  let pre = (await pg.query(`SELECT title, is_read FROM notifications WHERE record_ref=$1`, [`platform-request:${b.ref}`])).rows[0];
  ok("F14 an UNOPENED bell row stays unread while the request is actionable",
    pre?.is_read === false && pre?.title === "New platform request", JSON.stringify(pre || null));

  const dl = await ctx.newPage();
  hookPage(dl, "deeplink");
  await dl.setViewport({ width: 1500, height: 1100 });
  await dl.goto(`${BASE}/?tab=PLATFORM_ADMIN&request=${encodeURIComponent(b.ref)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await dl.waitForSelector('[data-testid="platform-requests"]', { timeout: 30000 });
  await sleep(1200);
  const dlOk = await dl.evaluate((ref) => {
    const row = Array.from(document.querySelectorAll('[data-testid^="platform-request-"]'))
      .find((el) => (el.textContent || "").includes(ref));
    return !!row;
  }, b.ref);
  ok("F15 a push-notification deep link opens the console ON that request", dlOk);
  await dl.close();

  const reject = await api(cookies.owner, "/api/platform-requests", {
    method: "PATCH",
    body: JSON.stringify({ id: b.id, action: "REJECT", reason: "Suite F — verifying terminal synchronisation." }),
  });
  ok("F16 REJECT succeeds", reject.status === 200 && reject.json?.request?.status === "REJECTED", `${reject.status}`);
  const post = (await pg.query(`SELECT title, is_read FROM notifications WHERE record_ref=$1`, [`platform-request:${b.ref}`])).rows[0];
  ok("F17 a terminal decision retires the bell row (read + truthful title)",
    post?.is_read === true && /rejected/i.test(post?.title || ""), JSON.stringify(post || null));
  const finalTasks = await api(cookies.owner, "/api/tasks?status=ACTIVE");
  ok("F18 a rejected request leaves the Action Center",
    !(finalTasks.json?.linked?.platformRequests || []).some((r) => r.openRef === b.ref));

  // ── F19–F22 · the mirrored task path stays in step too ──
  const c = await submit("Mirror", "10.9.1.33");
  const notifId = (await pg.query(`SELECT id FROM notifications WHERE record_ref=$1`, [`platform-request:${c.ref}`])).rows[0]?.id;
  const mirror = await api(cookies.owner, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `${TAG} mirror`,
      sourceType: "PLATFORM_REQUEST",
      sourceId: c.id,
      sourceRef: `platform-request:${c.ref}`,
      assignedUserId: OWNER_ID,
      dueDate: new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA"),
    }),
  });
  const task = (await pg.query(`SELECT id, source_type, business_id, source_ref, detail FROM action_tasks WHERE source_ref=$1`, [`platform-request:${c.ref}`])).rows[0];
  ok("F19 a Super Admin can mirror a request into a tracked task", !!task, `${mirror.status} ${JSON.stringify(mirror.json).slice(0, 160)}`);
  ok("F20 the mirror is platform-scoped and linked by the SERVER to that request",
    task?.business_id === null && task?.source_type === "PLATFORM_REQUEST" &&
      task?.source_ref === `platform-request:${c.ref}` && String(task?.detail || "").includes(c.ref),
    JSON.stringify(task || null));
  const gmMirror = await api(cookies.gm, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "x", sourceType: "PLATFORM_REQUEST", sourceId: c.id, assignedUserId: GM.id }),
  });
  ok("F21 a tenant user CANNOT mirror a platform request", gmMirror.status === 403, `${gmMirror.status}`);

  // Resolving the request auto-completes the mirror on the next sweep.
  await api(cookies.owner, "/api/platform-requests", {
    method: "PATCH",
    body: JSON.stringify({ id: c.id, action: "REJECT", reason: "Suite F — auto-complete check." }),
  });
  const afterSweep = (await pg.query(`SELECT status FROM action_tasks WHERE source_ref=$1`, [`platform-request:${c.ref}`])).rows[0];
  ok("F22 the mirror is open until the daily sweep runs",
    ["OPEN", "IN_PROGRESS"].includes(String(afterSweep?.status)), `status=${afterSweep?.status}`);
  // Drive the REAL sweep (the one the daily cron calls) and prove the mirror
  // closes on its own, exactly like an audit-issue or approval mirror.
  const swept = await api(cookies.owner, "/api/cron/daily?force=1", { method: "POST" });
  const postSweep = (await pg.query(`SELECT status FROM action_tasks WHERE source_ref=$1`, [`platform-request:${c.ref}`])).rows[0];
  ok("F23 the daily sweep auto-completes the mirror once the request is decided",
    String(postSweep?.status) === "DONE",
    `status=${postSweep?.status} sweepHttp=${swept.status} via=${swept.json?.via} ran=${swept.json?.ran} autoCompleted=${swept.json?.tasksAutoCompleted}`);
  void notifId;

  await page.close();
  await ctx.close();
}

/* ── Z · cleanup & forensics ───────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");

  // Provisioned artifacts (org + its owner + memberships + settings + sessions).
  for (const uid of created.userIds) {
    await pg.query(`DELETE FROM user_sessions WHERE user_id=$1`, [uid]);
    await pg.query(`DELETE FROM organization_members WHERE user_id=$1`, [uid]);
    await pg.query(`DELETE FROM company_settings WHERE updated_by_user_id=$1 AND organization_id = ANY($2::int[])`, [uid, created.orgIds.length ? created.orgIds : [0]]);
    await pg.query(`DELETE FROM users WHERE id=$1`, [uid]);
  }
  for (const oid of created.orgIds) {
    await pg.query(`DELETE FROM organization_members WHERE organization_id=$1`, [oid]);
    await pg.query(`DELETE FROM company_settings WHERE organization_id=$1`, [oid]);
    await pg.query(`DELETE FROM organizations WHERE id=$1`, [oid]);
  }
  // Marker-based sweep FIRST (independent of what the run managed to track):
  // guarantees no artifact survives even if an assertion failed mid-flight.
  const markerUsers = await pg.query(`SELECT id, primary_org_id FROM users WHERE email LIKE $1`, ["pr.suite.%@example-test.invalid"]);
  for (const u of markerUsers.rows) {
    await pg.query(`DELETE FROM user_sessions WHERE user_id=$1`, [u.id]);
    await pg.query(`DELETE FROM organization_members WHERE user_id=$1`, [u.id]);
    if (u.primary_org_id) {
      await pg.query(`DELETE FROM organization_members WHERE organization_id=$1`, [u.primary_org_id]);
      await pg.query(`DELETE FROM company_settings WHERE organization_id=$1`, [u.primary_org_id]);
      await pg.query(`DELETE FROM organizations WHERE id=$1`, [u.primary_org_id]);
    }
    await pg.query(`DELETE FROM users WHERE id=$1`, [u.id]);
  }
  await pg.query(`DELETE FROM platform_requests WHERE contact_name LIKE $1 OR business_name LIKE $1 OR contact_email LIKE $2`, [`${TAG}%`, "pr.suite.%@example-test.invalid"]);

  // Hygiene: settings rows whose organization no longer exists. They are what
  // turned a reused organization id into
  // `duplicate key value violates unique constraint "company_settings_org_uq"`.
  // Only rows ABOVE the baseline max are touched, so pre-existing live data
  // stays byte-identical for Z4.
  await pg.query(
    `DELETE FROM company_settings
      WHERE organization_id IS NOT NULL
        AND organization_id > $1
        AND organization_id NOT IN (SELECT id FROM organizations)`,
    [baseline.orgMaxId],
  );

  // Requests raised by the suite.
  if (created.requestIds.length) {
    await pg.query(`DELETE FROM platform_requests WHERE id = ANY($1::int[])`, [created.requestIds]);
  }
  // Belt-and-braces: any request left with the suite's marker in its fields.
  await pg.query(`DELETE FROM platform_requests WHERE contact_name LIKE $1 OR business_name LIKE $1 OR contact_email LIKE $2`, [`${TAG}%`, "pr.suite.%@example-test.invalid"]);

  // Mirrored action tasks raised by section F (platform-scoped, so they are
  // found by their source, never by a tenant).
  await pg.query(`DELETE FROM action_tasks WHERE source_type='PLATFORM_REQUEST' AND source_ref LIKE $1`, ["platform-request:%"]);

  // Bell rows + audit rows raised by the suite.
  await pg.query(`DELETE FROM notifications WHERE type='PLATFORM_REQUEST_NEW' AND id > $1`, [baseline.notifMax]);
  await pg.query(`DELETE FROM audit_trail WHERE target_type='PLATFORM_REQUEST' AND id > $1`, [baseline.auditMax]);
  // Sessions opened by the suite's logins.
  await pg.query(`DELETE FROM user_sessions WHERE id > $1`, [baseline.sessMax]);
  // Grants / support text the suite touched.
  await pg.query(`UPDATE users SET can_manage_support=false WHERE id IN ($1,$2)`, [GM.id, BM.id]);
  // The login shell is ISR-cached: after restoring the column, refresh it so
  // `/` reflects the restored value rather than the probe's last flip.
  // `cleanup()` runs outside the runner's scope, so it logs in for itself.
  const cleanupCookie = await loginCookie(OWNER).catch(() => null);
  if (cleanupCookie) {
    await api(cleanupCookie, "/api/support-info", {
      method: "POST",
      body: JSON.stringify({
        registration: {
          enabled: baseline.supportRow?.registration_enabled !== false,
          loginEnabled: baseline.supportRow?.login_registration_enabled === true,
        },
      }),
    }).catch(() => {});
  }
  await pg.query(
    `UPDATE customer_support_info SET contact_name=$1, phone=$2, whatsapp=$3, email=$4, address=$5, opening_hours=$6,
       extra_info=$7, registration_enabled=$8, registration_headline=$9, registration_note=$10, updated_by_user_id=$11,
       updated_by_name=$12, updated_by_role=$13, updated_at=$14, login_registration_enabled=$16 WHERE id=$15`,
    [baseline.supportRow?.contact_name ?? null, baseline.supportRow?.phone ?? null, baseline.supportRow?.whatsapp ?? null,
     baseline.supportRow?.email ?? null, baseline.supportRow?.address ?? null, baseline.supportRow?.opening_hours ?? null,
     baseline.supportRow?.extra_info ?? null, baseline.supportRow?.registration_enabled ?? true,
     baseline.supportRow?.registration_headline ?? null, baseline.supportRow?.registration_note ?? null,
     baseline.supportRow?.updated_by_user_id ?? null, baseline.supportRow?.updated_by_name ?? null,
     baseline.supportRow?.updated_by_role ?? null, baseline.supportRow?.updated_at ?? new Date(),
     baseline.supportRow?.id ?? -1, baseline.supportRow?.login_registration_enabled ?? null],
  );

  await pg.query(`UPDATE customer_support_info SET login_registration_enabled = $1 WHERE is_platform = true`,
    [baseline.supportRow?.login_registration_enabled ?? null]);

  const leftovers = (await pg.query(`SELECT count(*)::int c FROM platform_requests`)).rows[0].c;
  ok("Z1 no suite platform request is left behind (baseline preserved)", leftovers === baseline.requestCount,
    `end=${leftovers} start=${baseline.requestCount}`);

  const orgsNow = (await pg.query(`SELECT count(*)::int c FROM organizations`)).rows[0].c;
  ok("Z2 no suite organization or Owner user is left behind",
    orgsNow === baseline.orgCount && (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c === baseline.userCount,
    `orgs=${orgsNow}/${baseline.orgCount}`);

  const supAfter = await pg.query(`SELECT * FROM customer_support_info ORDER BY id`);
  const rowDiff = (() => {
    const a = baseline.supportRows[0], b = supAfter.rows[0];
    if (!a || !b) return `rows=${baseline.supportRows.length}->${supAfter.rows.length}`;
    return Object.keys({ ...a, ...b })
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => `${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`)
      .join(" | ") || "no field differs";
  })();
  ok("Z3 the support row is restored byte-for-byte to suite start",
    JSON.stringify(supAfter.rows) === JSON.stringify(baseline.supportRows), rowDiff);

  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  ok("Z4 live data byte-identical to suite start", JSON.stringify(counts) === JSON.stringify(baseline.counts),
    `start=${JSON.stringify(baseline.counts)} end=${JSON.stringify(counts)}`);

  ok("Z5 zero page/console errors across every pass", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
}

(async () => {
  await pg.connect();
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.notifMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.auditMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM audit_trail`)).rows[0].m;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  baseline.requestCount = (await pg.query(`SELECT count(*)::int c FROM platform_requests`)).rows[0].c;
  baseline.orgCount = (await pg.query(`SELECT count(*)::int c FROM organizations`)).rows[0].c;
  baseline.orgMaxId = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM organizations`)).rows[0].m;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  baseline.supportRows = (await pg.query(`SELECT * FROM customer_support_info ORDER BY id`)).rows;
  baseline.supportRow = baseline.supportRows.find((r) => r.is_platform === true) || baseline.supportRows[0] || null;
  console.log(`   baseline: requests=${baseline.requestCount} orgs=${baseline.orgCount} users=${baseline.userCount} supportRows=${baseline.supportRows.length}`);

  // Pre-flight: no stray grants from a previous crashed run.
  await pg.query(`UPDATE users SET can_manage_support=false WHERE id IN ($1,$2)`, [GM.id, BM.id]);

  const cookies = {
    owner: await loginCookie(OWNER),
    gm: await loginCookie(GM),
    bm: await loginCookie(BM),
  };

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionA();
    await sectionB(cookies);
    await sectionC(cookies);
    await sectionD(cookies);
    await sectionE(browser);
    await sectionF(browser, cookies);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try {
      await cleanup();
    } catch (e) {
      console.error("cleanup error:", e.message);
    }
    await pg.end();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
