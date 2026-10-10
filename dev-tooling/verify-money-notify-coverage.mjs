/**
 * verify-money-notify-coverage.mjs — STATIC GUARD, no server needed.
 *
 * Why a static guard exists at all
 * ────────────────────────────────
 * GoMina records money through many writers (`postSale`, `postServiceSale`,
 * `postOrGateExpenseTransaction`, hand-rolled `insert(transactions)`, …). Two
 * of them — the credit-sale installment and the payroll payment — posted a
 * real INCOME/EXPENSE row to the ledger while telling nobody, so the Owner's
 * daily revenue/expense figure silently under-counted those events forever
 * and nobody noticed: every dashboard, report and ledger row was correct, the
 * BELL was the only surface that lied.
 *
 * A behavioural suite (`verify-revenue-notifications.mjs`) proves the contract
 * end-to-end, but it only exercises the paths it knows about. This guard
 * closes the class of defect instead of the instance: ANY module that writes a
 * money row must reach a notifier — directly or through one of the shared
 * posting engines. A new money writer with no notification fails here at
 * review time, before it ships.
 *
 * Usage: node dev-tooling/verify-money-notify-coverage.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = join(ROOT, "src");

/** Modules that legitimately write money rows WITHOUT telling a bell:
 *  - the demo seeder (not a user action; the bell starts clean afterwards)
 *  - business provisioning's opening-stock kit (system, at unit creation) */
const SILENT_ALLOWED = {
  "src/db/seed.ts": "demo seed fixture — not a user action",
  "src/lib/businessProvisioning.ts": "opening-stock kit posted by the system when a unit is created",
};

/** The shared posting engines. A module that delegates to one of these is
 *  covered by definition — the engine owns the notification. */
const ENGINES = [
  "postSale(",
  "postServiceSale(",
  "postOrGateExpenseTransaction(",
  "notifyMoneyActivity",
  "notifyCreditPayment(",
];

/** Does this module write a `transactions` row at all? */
function writesMoney(source) {
  return /insert\(transactions\)/.test(source) && /type:\s*"(INCOME|EXPENSE)"/.test(source);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const offenders = [];
const covered = [];
const skipped = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  if (!writesMoney(src)) continue;
  if (SILENT_ALLOWED[rel]) {
    skipped.push(`${rel} — ${SILENT_ALLOWED[rel]}`);
    continue;
  }
  const engine = ENGINES.find((e) => src.includes(e));
  if (engine) covered.push(`${rel} (via ${engine})`);
  else offenders.push(rel);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

console.log("── Money writers ─────────────────────────────────────────");
for (const c of covered) console.log(`   covered  ${c}`);
for (const s of skipped) console.log(`   allowed  ${s}`);

ok(
  "every module that writes an INCOME/EXPENSE ledger row reaches a bell notifier",
  offenders.length === 0,
  offenders.join(", "),
);
ok("the guard actually found the writers it is meant to guard", covered.length >= 5, `${covered.length} covered`);

// The engines themselves must keep notifying — a refactor that drops the call
// inside an engine would silently blind every module that delegates to it.
const engineContracts = [
  ["src/lib/salePosting.ts", "notifyMoneyActivity", "postSale"],
  ["src/lib/servicePosting.ts", "notifyMoneyActivity", "postServiceSale"],
  ["src/lib/expensePosting.ts", "notifyMoneyActivity", "postOrGateExpenseTransaction"],
  ["src/app/api/credit-sales/route.ts", "notifyCreditPayment", "credit installment"],
  ["src/app/api/payroll/route.ts", "notifyMoneyActivity", "payroll payment"],
];
for (const [rel, needle, label] of engineContracts) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  ok(`engine still notifies · ${label} (${rel})`, src.includes(needle));
}

// ── Audience reachability ───────────────────────────────────────────────
// Every bell fan-out used to address its tenant purely through
// `organization_members`, a table ONLY organization provisioning fills. An
// OWNER account that predates multi-tenancy (or whose backfill never ran) has
// no row there, so that organization's fan-out resolved to an empty audience:
// money, orders, purchases and audit events all posted and the Owner's own
// workspace stayed silent. `orgRecipientUserIds` is the one resolver that
// unions `organizations.owner_user_id` with the membership rows, so it is the
// ONLY place allowed to project user ids off organization_members.
console.log("── Bell audience resolution ─────────────────────────────");
const notifySrc = readFileSync(join(ROOT, "src/lib/notify.ts"), "utf8");
const audienceSrc = readFileSync(join(ROOT, "src/lib/bellAudience.ts"), "utf8");
ok(
  "orgRecipientUserIds exists and consults the tenant's recorded owner",
  /export async function orgRecipientUserIds/.test(audienceSrc) &&
    /organizations\.ownerUserId/.test(audienceSrc),
);
ok(
  "bellAudience.workspaceAudience is the single resolver for \"whose workspace is this business\"",
  /export async function workspaceAudience/.test(audienceSrc) &&
    /businessManageIdsOf/.test(audienceSrc) &&
    /advisorAssignments/.test(audienceSrc),
);
ok(
  "workspaceAudience honours every reach the app honours: assignment, manage-delegation, grants, Super Admin",
  /assignedBusinessId/.test(audienceSrc) &&
    /businessManageIds/.test(audienceSrc) &&
    /userBusinessAccess/.test(audienceSrc) &&
    /isSuperAdmin === true/.test(audienceSrc),
);
ok(
  "a FARM_ADVISOR reaches a unit only through a live advisor grant, never org membership",
  /FARM_ADVISOR/.test(audienceSrc) && /advisorTo\.get/.test(audienceSrc),
);
ok(
  "self-exclusion is owner-aware (withoutSelf keeps OWNER / Super Admin)",
  /export function withoutSelf/.test(audienceSrc) && /isWorkspacePrincipal/.test(audienceSrc),
);
ok(
  "every producer resolves its audience through workspaceAudience, not a private copy",
  ["src/lib/notify.ts", "src/lib/notifyActivity.ts"].every((rel) =>
    /workspaceAudience/.test(readFileSync(join(ROOT, rel), "utf8")),
  ),
);
ok(
  "no producer still hand-rolls the actor exclusion that hid the Owner",
  ["src/lib/notify.ts", "src/lib/notifyActivity.ts"].every((rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    return !/!== Number\(input\.actorUserId/.test(src) && !/!== Number\(u\.id\)/.test(src);
  }),
);
// Only a genuine AUDIENCE OWNER may be judged here: a module that exports a
// audience fan-out. Deliberately NOT judged — /api/audit and /api/tasks
// use the same select inside a tenant GUARD that NARROWS who may be assigned
// work, and a member-management screen must keep listing real membership
// rows. Widening either would be a permissions change, not a notification
// fix, and this audit leaves permissions exactly as it found them.
// …Recipients fan-outs and the approver resolver — every place the bell's
// or an approval's audience is decided.
const ownsABellAudience = (src) =>
  /export (?:async )?function \w*(?:Recipients|Approvers)\s*\(/.test(src);
const audienceOffenders = [];
const audienceOwners = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  // bellAudience.ts IS the resolver now — every audience derives from it.
  if (rel === "src/lib/bellAudience.ts") continue;
  const src = readFileSync(file, "utf8");
  if (!ownsABellAudience(src)) continue;
  if (/select\(\{[^}]*userId:\s*organizationMembers\.userId/.test(src)) {
    audienceOffenders.push(rel);
    continue;
  }
  audienceOwners.push(rel);
}
ok(
  "no bell-audience owner re-derives its audience straight off organization_members",
  audienceOffenders.length === 0,
  audienceOffenders.join(", "),
);
console.log(`   ${audienceOwners.length} bell-audience owner(s) checked`);
for (const rel of ["src/lib/notifyActivity.ts", "src/lib/approvals.ts", "src/lib/transport.ts"]) {
  ok(`audience resolved through the bell resolver · ${rel}`,
    /bellAudience/.test(readFileSync(join(ROOT, rel), "utf8")));
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY GUARD — closes the routing defect class (audit F-06/F-07/F-09, RC-1)
// ═══════════════════════════════════════════════════════════════════════════
// Before `src/lib/bellTypes.ts` the app had FOUR parallel lookup tables that
// had to agree about a notification and nothing checked that they did. The
// measurable result: 18 of 42 emitted types opened Customer Order & Tracking
// from a push, and 12 rendered in the bell as the generic "Open Record" chip.
// The registry makes both structurally impossible, and these checks keep it
// honest.
console.log("── Notification registry ──────────────────────────────────────────");
const typesSrc = readFileSync(join(ROOT, "src/lib/bellTypes.ts"), "utf8");
ok(
  "the registry exists and is the single source for label/category/destination",
  /export const BELL_TYPES/.test(typesSrc) &&
    /export function lookupBellType/.test(typesSrc) &&
    /export function bellDestinationTab/.test(typesSrc) &&
    /export function bellCategoryFor/.test(typesSrc),
);
// The three former parallel maps must now be thin delegations, not copies.
const pushSrc = readFileSync(join(ROOT, "src/lib/push.ts"), "utf8");
ok(
  "push.ts delegates routing to the registry instead of keeping its own table",
  /urlForTab/.test(pushSrc) || /bellDestinationTab/.test(pushSrc),
);
ok(
  "push.ts no longer carries its own TYPE_CATEGORY map",
  !/const TYPE_CATEGORY/.test(pushSrc),
);
const bellSrc = readFileSync(join(ROOT, "src/components/NotificationBell.tsx"), "utf8");
ok("the bell's chip label comes from the registry", /lookupBellType/.test(bellSrc));
const appSrc = readFileSync(join(ROOT, "src/components/GoMinaApp.tsx"), "utf8");
ok("the bell's click destination falls back to the registry", /lookupBellType/.test(appSrc));
ok(
  "no producer hardcodes a destination tab in its push payload any more",
  !/url:\s*"\/\?tab=/.test(readFileSync(join(ROOT, "src/lib/transport.ts"), "utf8")),
);

// Every `type: "…"` literal the app writes must be a registered type (or match a
// registered prefix family). This is the check that would have caught F-06/F-09
// on the day they were written.
const registered = new Set(
  (typesSrc.match(/REGISTERED_BELL_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/) || [, ""])[1]
    .match(/"([A-Z_]+)"/g)
    .map((m) => m.replace(/"/g, "")),
);
const prefixes = new Set(
  (typesSrc.match(/BELL_TYPE_PREFIXES:[\s\S]*?prefix:\s*"([A-Z_]+)"/g) || [])
    .map((m) => /"([A-Z_]+)"/.exec(m)[1]),
);
for (const m of typesSrc.matchAll(/\{\s*prefix:\s*"([A-Z_]+)"/g)) prefixes.add(m[1]);
const isRegistered = (t) =>
  registered.has(t) || [...prefixes].some((p) => p && t.startsWith(p));

// Scan ONLY files that actually write a bell row or call a bell helper. The
// app has many other tables with a `type:` column (`transactions.type` holds
// OPS_LOG / INCOME / EXPENSE; Customer360 follow-ups use CALL / CORPORATE /
// RETAIL), and a whole-tree scan reports those as unregistered types.
const WRITES_NOTIFICATIONS = /insert\(notifications\)|notifyTaskUser|notifyAuditEvent|notifyMoneyActivity|notifyAuditIssue|millBell|mixBell|async function bell\(|function notify\(/;
const emitted = new Set();
const TYPE_LITERAL = /\btype:\s*"([A-Z][A-Z0-9_]{2,40})"/g;
for (const file of walk(SRC)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const src = readFileSync(file, "utf8");
  if (!WRITES_NOTIFICATIONS.test(src)) continue;
  for (const m of src.matchAll(TYPE_LITERAL)) emitted.add(m[1]);
}
// A file can both write a bell row and insert rows on OTHER tables; `type:` on
// those is not a notification type. These are the app's other enum values.
const NOT_NOTIFICATION_TYPES = new Set([
  "INCOME", "EXPENSE", "WHOLESALE", "CORPORATE", "RETAIL", "CALL", "OPS_LOG",
  "STREET", "CITY", "POI", "NEIGHBOURHOOD", "LANDMARK", "WIFI_VOUCHER", "CAGE",
  "DELIVERY", "TRANSACTION", "FOLLOW_UP", "CHECKLIST",
]);
const unregistered = [...emitted].filter((t) => !isRegistered(t) && !NOT_NOTIFICATION_TYPES.has(t));
ok(
  "every notification type emitted anywhere in src/ is registered in bellTypes.ts",
  unregistered.length === 0,
  unregistered.join(", "),
);
console.log(`   ${emitted.size} type literals scanned · ${registered.size} types registered · ${prefixes.size} prefix families`);

// The registry's own routing table must cover every registered type, and the
// old "everything unknown goes to Customer Tracking" catch-all must be gone.
ok(
  "the registry's fallback is the Command Center, never Customer Tracking",
  /FALLBACK_TAB = "COMMAND_CENTER"/.test(typesSrc) &&
    !/return "\/?tab=TRACKING"\s*;?\s*$/m.test(pushSrc.replace(/[\s\S]*?export function urlForNotification/, "")),
);

// ═══════════════════════════════════════════════════════════════════════════
// ACTION CENTER TRANSITION GUARD — closes F-02/F-03/F-04/F-05/F-10
// ═══════════════════════════════════════════════════════════════════════════
console.log("── Action Center transitions ──────────────────────────────────────");
const acSrc = readFileSync(join(ROOT, "src/lib/actionCenter.ts"), "utf8");
// Comments in these files DESCRIBE the bugs they forbid, so a naive scan
// reads the explanation as the defect. Strip comments before scanning.
const acCode = acSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
for (const evt of ["raised", "started", "done", "cancelled", "reopened", "overdue"]) {
  ok(`transition declared in the table · ${evt}`, new RegExp(`^\\s+${evt}:\\s*\\{`, "m").test(acSrc));
}
ok(
  "the table owns the audience (assignee / creator / principals per event)",
  /export const TASK_EVENTS/.test(acSrc) && /to:\s*\[/.test(acSrc),
);
ok(
  "ONE notification path: no ad-hoc task fan-out remains beside the table",
  (acCode.match(/notifyTaskUser\(/g) || []).length === 2, // the definition + the table's own call
);
ok(
  "no per-recipient recordRef suffix is used to defeat dedupe (the :watch bug)",
  !/recordRef: `\$\{recordRef\}:watch`/.test(acCode) && !/task-overdue:/.test(acCode),
);
ok(
  "the overdue escalation keeps one recordRef for every recipient",
  /recordRef: `task:\$\{t\.id\}:overdue:\$\{step\}`/.test(acCode),
);
const tasksRouteSrc = readFileSync(join(ROOT, "src/app/api/tasks/route.ts"), "utf8");
ok(
  "the PATCH route delegates every status change to the transition table",
  /notifyTaskTransition/.test(tasksRouteSrc) && !/type:\s*"TASK_COMPLETED"/.test(tasksRouteSrc),
);
ok(
  "the completion block is no longer gated on a non-null creator",
  !/task\.createdByUserId != null &&[\s\S]{0,200}workspacePrincipals/.test(tasksRouteSrc),
);

// ═══════════════════════════════════════════════════════════════════════════
// TRANSPORT AUDIENCE GUARD — closes F-01 (audit) / RC-3
// ═══════════════════════════════════════════════════════════════════════════
console.log("── Transport audience ─────────────────────────────────────────────");
const trSrc = readFileSync(join(ROOT, "src/lib/transport.ts"), "utf8");
ok(
  "notifyTransport resolves through the canonical audience",
  /workspaceAudience/.test(trSrc),
);
ok(
  "notifyTransport no longer hand-rolls a role whitelist from organization_members",
  !/orgRecipientUserIds/.test(trSrc) && !/role === "OWNER" \|\| u\.role === "GENERAL_MANAGER"/.test(trSrc),
);
ok(
  "notifyTransport dedupes on recordRef (the event), not on unread state",
  /eq\(notifications\.recordRef, input\.recordRef/.test(trSrc) && !/eq\(notifications\.isRead, false\)/.test(trSrc),
);

// The chart regression guard: the exact CSS that broke every chart in the app.
// Any rule whose selector list mentions `.recharts-wrapper` must NOT carry a
// percentage (or any positive) max-width — that value resolves against
// recharts' deliberate 0×0 auto-sizer div and collapses the chart.
const cssRaw = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
// Comments explain this exact trap, so they must be stripped before the
// selector scan or every prose mention of `.recharts-wrapper` reads as a rule.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const wrapperRules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/\.recharts-wrapper/.test(m[1])) continue;
  const mw = /max-width:\s*([^;]+)/.exec(m[2]);
  wrapperRules.push({ selector: m[1].trim().replace(/\s+/g, " "), maxWidth: mw ? mw[1].trim() : null });
}
const badWrapperRules = wrapperRules.filter(
  (r) => r.maxWidth !== null && r.maxWidth !== "none",
);
console.log("── Chart CSS ────────────────────────────────────────────");
for (const r of wrapperRules) console.log(`   ${r.selector} { max-width: ${r.maxWidth ?? "(unset)"} }`);
ok(
  "no rule clamps .recharts-wrapper with a max-width other than none",
  badWrapperRules.length === 0,
  badWrapperRules.map((r) => `${r.selector}{max-width:${r.maxWidth}}`).join(", "),
);
ok(
  "the recharts outer container keeps its anti-spill clamp (page never scrolls sideways)",
  /\.recharts-responsive-container\s*\{[^}]*max-width:\s*100%/.test(css),
);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);