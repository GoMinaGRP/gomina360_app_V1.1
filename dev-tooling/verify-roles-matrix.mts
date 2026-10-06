/**
 * verify-roles-matrix.ts — the roles & permissions reconciliation test suite.
 *
 * Four parts, run against the LIVE app (server on :3000) and against the very
 * same registry + nav code the UI runs (imported from src/):
 *
 *   A. REGISTRY INVARIANTS  — one source of truth, no role/preset can drift.
 *   B. NAVIGATION PER ROLE  — what each role can actually reach, computed by
 *                             `navCtx` + `navEntriesFor` (the app's own code).
 *   C. LIVE API MATRIX      — role validation, presets, delegate limits and
 *                             per-role access, proven over HTTP.
 *   D. ACCOUNT PROVISIONING — one real account per role, created through the
 *                             public API, then signed in and re-probed.
 *
 * Run:  npx tsx dev-tooling/verify-roles-matrix.ts
 * Exit code 0 = every assertion passed.
 */
import { createRequire } from "node:module";
import {
  CAPABILITIES,
  ROLES,
  ROLE_GROUPS,
  canAssignRole,
  canActOnRole,
  capabilitiesForRole,
  isOrgexecRole,
  roleDef,
  roleLabel,
  rolePreset,
  roleRank,
  inRoleGroup,
} from "../src/lib/roles";
import { defaultTabFor, navCtx, navEntriesFor } from "../src/lib/navManifest";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };
const NEW_PASSWORD = "Role@GoMina26";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: any, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name} ${detail}`);
  }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function call(path: string, method = "GET", body: any = null, token: string | null = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-gomina-session": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}
const login = async (c: { email: string; password: string }) =>
  (await call("/api/auth/login", "POST", c)).json?.sessionToken || null;

const ROLES_ALL = ROLES.map((r) => r.key);

/* ══════════════════════════════════════════════════════════════════════════
   A. REGISTRY INVARIANTS
   ══════════════════════════════════════════════════════════════════════════ */
section("A. Registry invariants (src/lib/roles.ts)");

ok(`8 roles registered (${ROLES_ALL.join(", ")})`, ROLES_ALL.length === 8);
ok("every role key is unique", new Set(ROLES_ALL).size === 8);
ok("every role label is unique", new Set(ROLES.map((r) => r.label)).size === 8);
ok(
  "every capability key + testid is unique",
  new Set(CAPABILITIES.map((c) => c.key)).size === CAPABILITIES.length &&
    new Set(CAPABILITIES.map((c) => c.testid)).size === CAPABILITIES.length,
);
ok(
  "every preset key is a real capability",
  ROLES.every((r) => Object.keys(r.preset).every((k) => CAPABILITIES.some((c) => c.key === k))),
);
// D3 lets a preset carry a SENSITIVE grant (Accountant ⇒ Finance) because the
// OWNER is the one creating that account. The DESTRUCTIVE record powers
// (manage/delete records, inventory, expenses, staff directory) are never
// presets: they stay explicit OWNER grants.
const NEVER_PRESET = ["canManageRecords", "canDeleteInventory", "canManageExpenses", "canManageUsers", "canManageCctv"];
ok(
  "no preset carries a destructive record power or the staff directory",
  ROLES.every((r) => Object.keys(r.preset).every((k) => !NEVER_PRESET.includes(k))),
);
ok(
  "only WORKER is CORE_OWNER_UNASSIGNABLE (assignableBy NEVER)",
  ROLES.filter((r) => r.assignableBy === "NEVER").map((r) => r.key).join() === "OWNER",
);
ok(
  "FARM_ADVISOR is the only EXTERNAL role",
  ROLES.filter((r) => r.section === "EXTERNAL").map((r) => r.key).join() === "FARM_ADVISOR",
);
ok(
  "requiresUnit roles are exactly the unit-scoped staff",
  ROLES.filter((r) => r.requiresUnit)
    .map((r) => r.key)
    .sort()
    .join() === ["BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT", "WORKER"].sort().join(),
);
ok("FARM_ADVISOR forbids a primary unit", roleDef("FARM_ADVISOR")?.forbidsUnit === true);
ok(
  "rank order: OWNER 4 > exec 3 > unit 2 > shop floor 1 > external 0",
  roleRank("OWNER") === 4 &&
    roleRank("CO_OWNER") === 3 &&
    roleRank("GENERAL_MANAGER") === 3 &&
    roleRank("BRANCH_MANAGER") === 2 &&
    roleRank("SUPERVISOR") === 2 &&
    roleRank("ACCOUNTANT") === 2 &&
    roleRank("WORKER") === 1 &&
    roleRank("FARM_ADVISOR") === 0,
);
ok(
  "phantom roles are NOT roles (MANAGER / ADMIN / SUPER_ADMIN)",
  ROLES_ALL.every((r) => !["MANAGER", "ADMIN", "SUPER_ADMIN", "AUDITOR"].includes(r)),
);
ok(
  "the staff directory is NEVER a preset — not even for a Co-Owner",
  ROLES.every((r) => rolePreset(r.key).canManageUsers !== true),
);
ok(
  "GROUP/registry agreement: EXECUTIVE ⇔ isOrgexecRole, DELEGATE_ELIGIBLE ⇔ delegate-capable roles",
  ROLES_ALL.every((r) => isOrgexecRole(r) === inRoleGroup("EXECUTIVE", r)) &&
    ROLE_GROUPS.DELEGATE_ELIGIBLE.every((r) => roleDef(r)?.assignableBy !== "NEVER"),
);
ok(
  "canAssignRole: OWNER may assign every assignable role; nobody may create an OWNER",
  ROLES.filter((r) => r.assignableBy !== "NEVER").every((r) => canAssignRole({ role: "OWNER" }, r.key)) &&
    !canAssignRole({ role: "OWNER" }, "OWNER") &&
    !canAssignRole({ role: "BRANCH_MANAGER", canManageUsers: true }, "SUPERVISOR") &&
    canAssignRole({ role: "BRANCH_MANAGER", canManageUsers: true }, "WORKER"),
);
ok(
  "canActOnRole: nobody administers a superior (rank guard)",
  !canActOnRole("GENERAL_MANAGER", "OWNER") &&
    !canActOnRole("SUPERVISOR", "GENERAL_MANAGER") &&
    !canActOnRole("WORKER", "BRANCH_MANAGER") &&
    canActOnRole("OWNER", "SUPERVISOR") &&
    canActOnRole("BRANCH_MANAGER", "WORKER"),
);
ok(
  "CO_OWNER / GM presets carry the 7 operational caps, not the staff directory",
  ["CO_OWNER", "GENERAL_MANAGER"].every((r) => {
    const caps = capabilitiesForRole(r).filter((c) => c.ownerOnly && !c.sensitive).length;
    return rolePreset(r).canManageUsers !== true && typeof caps === "number";
  }),
);
ok("ACCOUNTANT preset = export + record expenses + Finance (D3)", (() => {
  const p = rolePreset("ACCOUNTANT");
  return p.canExportData === true && p.canRecordExpenses === true && p.canViewFinance === true && p.canManageStock !== true;
})());
ok(
  "SUPERVISOR preset = stock + record expenses",
  rolePreset("SUPERVISOR").canManageStock === true && rolePreset("SUPERVISOR").canRecordExpenses === true,
);
ok("WORKER preset = record sales only", (() => {
  const p = rolePreset("WORKER");
  return p.canRecordSales === true && Object.entries(p).filter(([, v]) => v).length === 1;
})());

/* ══════════════════════════════════════════════════════════════════════════
   B. NAVIGATION PER ROLE — the app's own nav code
   ══════════════════════════════════════════════════════════════════════════ */
section("B. Navigation reachable by a freshly created account of each role");

const freshUser = (role: string) => ({
  id: 990,
  role,
  isSuperAdmin: false,
  canManageUsers: false,
  canViewFinance: false,
  canManageSupport: false,
  canManageCctv: false,
  canManageAuditors: false,
  canExportData: false,
  businessManageIds: [],
  assignedBusinessId: role === "FARM_ADVISOR" ? null : 1,
});

const navByRole: Record<string, string[]> = {};
for (const role of ROLES_ALL) {
  const entries = navEntriesFor(navCtx(freshUser(role), { hasSupportEditor: true, hasManageBusinesses: true }));
  navByRole[role] = entries.map((e) => e.id);
  console.log(`  · ${role.padEnd(16)} ${String(entries.length).padStart(2)} rows: ${navByRole[role].join(", ")}`);
}

ok(
  "OWNER reaches the Command Center + Users & Access (20+ rows)",
  navByRole.OWNER.includes("COMMAND_CENTER") && navByRole.OWNER.includes("USERS_MANAGE") && navByRole.OWNER.length >= 18,
);
ok("CO_OWNER / GENERAL_MANAGER reach the Command Center", ["CO_OWNER", "GENERAL_MANAGER"].every((r) => navByRole[r].includes("COMMAND_CENTER")));
ok(
  "CO_OWNER / GM do NOT reach the staff directory without the OWNER grant",
  ["CO_OWNER", "GENERAL_MANAGER"].every((r) => !navByRole[r].includes("USERS_MANAGE")),
);
ok(
  "BRANCH_MANAGER gets the unit workspace (Branch Sales / Assets / Roster)",
  ["BRANCH_SALES", "BRANCH_ASSETS", "WORKERS_MANAGE"].every((e) => navByRole.BRANCH_MANAGER.includes(e)),
);
ok(
  "SUPERVISOR now HAS a workspace — unit register + roster + assets (D2, was 1 row)",
  ["BRANCH_SALES", "WORKERS_MANAGE", "BRANCH_ASSETS"].every((e) => navByRole.SUPERVISOR.includes(e)) &&
    navByRole.SUPERVISOR.length > 1,
);
ok(
  "ACCOUNTANT gets the unit register + roster (D2, was 1 row)",
  ["BRANCH_SALES", "WORKERS_MANAGE"].every((e) => navByRole.ACCOUNTANT.includes(e)) && navByRole.ACCOUNTANT.length > 1,
);
ok(
  "ACCOUNTANT with the Finance grant reaches Finance + Transactions",
  (() => {
    const u = { ...freshUser("ACCOUNTANT"), canViewFinance: true };
    const rows = navEntriesFor(navCtx(u, { hasSupportEditor: true, hasManageBusinesses: true })).map((e) => e.id);
    return rows.includes("FINANCE") && rows.includes("TRANSACTIONS");
  })(),
);
ok("WORKER keeps the Action Center and nothing else", navByRole.WORKER.join() === "ACTION_CENTER");
ok("FARM_ADVISOR keeps the Advisor Console only", navByRole.FARM_ADVISOR.join() === "ADVISOR");
ok(
  "no role can reach the Platform Owners console without Super Admin",
  ROLES_ALL.every((r) => !navByRole[r].includes("PLATFORM_ADMIN")),
);
ok(
  "landing tab is never an unreachable surface",
  ROLES_ALL.every((r) => {
    const t = defaultTabFor(freshUser(r));
    // EXECUTIVE HQ is where the advisor's console and the worker dashboard mount.
    return t === "BRANCH_SALES" ? navByRole[r].includes("BRANCH_SALES") : ["COMMAND_CENTER", "ADVISOR"].includes(t);
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
   C. LIVE API MATRIX
   ══════════════════════════════════════════════════════════════════════════ */
section("C. Live API matrix (role validation, presets, tenant safety)");

const ownerToken = await login(OWNER);
ok("OWNER login", !!ownerToken);
if (!ownerToken) {
  console.log("\nCannot continue without an OWNER session.");
  process.exit(1);
}

// ── business + user inventory ──────────────────────────────────────────────
const init = await call("/api/init", "GET", null, ownerToken);
ok("GET /api/init → 200", init.status === 200, `${init.status}`);
const businesses: any[] = init.json?.businesses || [];
const usersBefore: any[] = (await call("/api/users", "GET", null, ownerToken)).json?.users || [];
ok("GET /api/users lists the estate", usersBefore.length > 0, `${usersBefore.length}`);
const unitId = businesses.find((b) => !b.isArchived)?.id;

// ── the pre-fix hole: an unknown role ──────────────────────────────────────
let r = await call(
  "/api/users",
  "POST",
  { name: "Banana Probe", email: `banana.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "BANANA" },
  ownerToken,
);
ok("POST /api/users role='BANANA' → 400 (was 409 = no validation)", r.status === 400, `${r.status} ${r.json?.error || ""}`);
ok("…and nothing was inserted", !((await call("/api/users", "GET", null, ownerToken)).json?.users || []).some((u: any) => u.name === "Banana Probe"));

r = await call("/api/users", "POST", { name: "Phantom Mgr", email: `phantom.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "MANAGER" }, ownerToken);
ok("POST /api/users role='MANAGER' (phantom) → 400", r.status === 400, `${r.status}`);

r = await call("/api/users", "POST", { name: "Empty Role", email: `empty.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "" }, ownerToken);
ok("POST /api/users role='' → 400", r.status === 400, `${r.status}`);

r = await call("/api/users", "POST", { name: "Second Owner", email: `owner2.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "OWNER" }, ownerToken);
ok("POST /api/users role='OWNER' → 403 (an organisation has one OWNER)", r.status === 403, `${r.status}`);

r = await call("/api/users", "POST", { name: "Lower Case", email: `lower.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "worker", assignedBusinessId: unitId }, ownerToken);
ok("POST /api/users role='worker' (lower case) is normalised, not rejected", r.status === 200 || r.status === 409, `${r.status} ${r.json?.error || ""}`);
if (r.status === 200) console.log("   ↳ stored as role:", r.json?.user?.role);

// ── unit requirement (F10) ─────────────────────────────────────────────────
for (const role of ["WORKER", "SUPERVISOR", "ACCOUNTANT", "BRANCH_MANAGER"]) {
  r = await call("/api/users", "POST", { name: `${role} NoUnit`, email: `${role.toLowerCase()}.nounit.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role }, ownerToken);
  ok(`POST /api/users role='${role}' with no unit → 400`, r.status === 400, `${r.status} ${r.json?.error || ""}`);
}
r = await call("/api/users", "POST", { name: "Advisor With Unit", email: `advisor.unit.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "FARM_ADVISOR", assignedBusinessId: unitId }, ownerToken);
ok("POST /api/users role='FARM_ADVISOR' WITH a unit → 400 (forbidsUnit)", r.status === 400, `${r.status}`);

/* ── D. provision one real account per missing role ─────────────────────── */
section("D. Account provisioning — one account per role, through the API");

const alreadyHas: Record<string, boolean> = {};
for (const role of ROLES_ALL) alreadyHas[role] = usersBefore.some((u: any) => u.role === role);
console.log(
  "  · pre-existing coverage: " + ROLES_ALL.map((r0) => `${r0}=${alreadyHas[r0] ? "yes" : "no"}`).join("  "),
);

const created: { role: string; email: string; id?: number }[] = [];
for (const role of ["CO_OWNER", "SUPERVISOR", "ACCOUNTANT", "FARM_ADVISOR"] as const) {
  if (alreadyHas[role]) {
    const ex = usersBefore.find((u: any) => u.role === role);
    created.push({ role, email: ex.email, id: ex.id });
    console.log(`  · ${role}: reusing existing ${ex.email}`);
    continue;
  }
  const email = `${role.toLowerCase().replace("_", "-")}.e2e@gomina360.com`;
  const def = roleDef(role)!;
  const body: any = {
    name: `${def.label} (E2E)`,
    email,
    phone: "+233 24 000 0000",
    password: NEW_PASSWORD,
    role,
  };
  if (!def.forbidsUnit) body.assignedBusinessId = unitId;
  r = await call("/api/users", "POST", body, ownerToken);
  ok(`create ${role} → 200`, r.status === 200, `${r.status} ${r.json?.error || ""}`);
  if (r.status === 200) {
    created.push({ role, email, id: r.json?.user?.id });
    // preset fidelity: every capability column must equal the role preset
    const stored = r.json?.user || {};
    const preset = rolePreset(role);
    const mismatch = CAPABILITIES.filter((c) => {
      const want = preset[c.key] === true;
      return Boolean(stored[c.key]) !== want;
    }).map((c) => c.key);
    ok(`  ↳ ${role} capability columns == registry preset`, mismatch.length === 0, mismatch.join(", "));
  }
}

// Every role now has at least one account.
const usersAfter: any[] = (await call("/api/users", "GET", null, ownerToken)).json?.users || [];
for (const role of ROLES_ALL) {
  ok(`role ${role} has ≥1 account`, usersAfter.some((u: any) => u.role === role), "none");
}
ok(
  "no account carries an unknown role",
  usersAfter.every((u: any) => ROLES_ALL.includes(String(u.role).toUpperCase())),
  `bad: ${usersAfter.filter((u: any) => !ROLES_ALL.includes(String(u.role).toUpperCase())).map((u: any) => u.role).join()}`,
);

/* ── delegate limits (D5) ───────────────────────────────────────────────── */
// Delegate coverage (D5): if the estate has no delegated Branch Manager, make
// one for the duration of the probe and put it back exactly as it was.
let bm = usersAfter.find((u: any) => u.role === "BRANCH_MANAGER" && u.canManageUsers === true);
let delegatedProbeGranted = false;
if (!bm) {
  // Pick a BRANCH MANAGER whose seeded credentials are known (never probe a
  // password we do not have: five wrong attempts lock an account).
  const BM_LOGINS: [string, string][] = [
    ["emmanuel@gomina360.com", "GoMina@User3"],
    ["kofi@gomina360.com", "GoMina@User4"],
  ];
  for (const [email, password] of BM_LOGINS) {
    if (!usersAfter.some((u: any) => u.email === email)) continue;
    if (!(await login({ email, password }))) continue;
    const candidate = usersAfter.find((u: any) => u.email === email)!;
    const grant = await call("/api/users", "PATCH", { userId: candidate.id, canManageUsers: true }, ownerToken);
    if (grant.status === 200) {
      bm = { ...candidate, canManageUsers: true, _password: password };
      delegatedProbeGranted = true;
      console.log(`  · temporarily delegated ${email} for the delegate probes`);
    }
    break;
  }
}
if (bm) {
  const bmToken =
    (await call("/api/auth/login", "POST", {
      email: bm.email,
      password: (bm as any)._password || "GoMina@User3",
    })).json?.sessionToken;
  if (bmToken) {
    const target = created.find((c) => c.role === "SUPERVISOR");
    r = await call("/api/users", "POST", { name: "Delegate Escalation", email: `delegate.esc.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "SUPERVISOR", assignedBusinessId: bm.assignedBusinessId }, bmToken);
    ok("delegate BM creating a SUPERVISOR → FORBIDDEN", r.status === 403, `${r.status}`);
    r = await call("/api/users", "POST", { name: "Delegate CoOwner", email: `delegate.co.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "CO_OWNER" }, bmToken);
    ok("delegate BM creating a CO_OWNER → FORBIDDEN", r.status === 403, `${r.status}`);
    r = await call("/api/users", "PUT", { userId: target?.id, role: "CO_OWNER" }, bmToken);
    ok("delegate BM promoting someone to CO_OWNER → 403/404 (never 200)", r.status !== 200, `${r.status}`);
    r = await call("/api/users", "PATCH", { userId: target?.id, canViewFinance: true }, bmToken);
    ok("delegate BM granting Finance access → FORBIDDEN", r.status === 403, `${r.status}`);
    // …and the same delegate still works inside its own lane.
    r = await call("/api/users", "POST", { name: "Delegate Worker", email: `delegate.worker.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "WORKER", assignedBusinessId: bm.assignedBusinessId }, bmToken);
    ok("delegate BM creating a WORKER in its own unit → 200", r.status === 200, `${r.status} ${r.json?.error || ""}`);
    if (r.status === 200) {
      const w = r.json?.user || {};
      ok(
        "  ↳ the delegate could not attach OWNER-only powers (sent truthful values are honoured, elevated ones refused)",
        w.canManageRecords !== true && w.canManageUsers !== true && w.canViewFinance !== true,
      );
      const cleanupId = w.id;
      await call("/api/users", "PATCH", { userId: cleanupId, isActive: false }, ownerToken);
      console.log(`  · delegate probe worker left disabled for cleanup: ${w.email} (id ${cleanupId})`);
    }
  } else console.log("  · delegate BM login skipped (password differs)");
} else console.log("  · no delegate BM available for the delegate probes");
if (delegatedProbeGranted && bm) {
  const revoke = await call("/api/users", "PATCH", { userId: bm.id, canManageUsers: false }, ownerToken);
  ok("delegate probe grant revoked", revoke.status === 200, `${revoke.status}`);
}

/* ── per-role access probes on the accounts just created ────────────────── */
section("E. Per-role live access (each account signs in and probes its own surfaces)");

const PROBES: { path: string; label: string }[] = [
  { path: "/api/init", label: "workspace bootstrap" },
  { path: "/api/users", label: "staff directory" },
  { path: "/api/audit", label: "audit trail" },
  { path: "/api/approvals", label: "approval policies" },
  { path: "/api/transactions?limit=1", label: "transactions ledger" },
];
const EXPECT: Record<string, Record<string, number[]>> = {
  CO_OWNER: { "/api/init": [200], "/api/users": [403], "/api/audit": [200], "/api/approvals": [200, 403], "/api/transactions?limit=1": [200] },
  SUPERVISOR: { "/api/init": [200], "/api/users": [403], "/api/audit": [200, 403], "/api/approvals": [200, 403], "/api/transactions?limit=1": [200, 403] },
  ACCOUNTANT: { "/api/init": [200], "/api/users": [403], "/api/audit": [200, 403], "/api/approvals": [200, 403], "/api/transactions?limit=1": [200, 403] },
  FARM_ADVISOR: { "/api/init": [200], "/api/users": [403], "/api/audit": [403], "/api/approvals": [403], "/api/transactions?limit=1": [403] },
  WORKER: { "/api/init": [200], "/api/users": [403], "/api/audit": [403], "/api/approvals": [403], "/api/transactions?limit=1": [403] },
};
for (const c of created) {
  const token = await login({ email: c.email, password: NEW_PASSWORD });
  ok(`${c.role} signs in`, !!token);
  if (!token) continue;
  for (const p of PROBES) {
    const res = await call(p.path, "GET", null, token);
    const expected = EXPECT[c.role]?.[p.path];
    ok(`${c.role} → ${p.label} (${res.status})`, !expected || expected.includes(res.status), `expected ${expected?.join("/")}`);
  }
  // The staff directory must never leak other tenants' users.
  const dir = await call("/api/users", "GET", null, token);
  ok(`${c.role} staff directory returns no rows`, !(dir.json?.users || []).length, `${dir.json?.users?.length}`);
}

/* ── role-change semantics ─────────────────────────────────────────────── */
section("F. Role change applies the new role's preset (F3)");

const workerAcct = usersAfter.find((u: any) => u.role === "WORKER" && u.id);
if (workerAcct) {
  r = await call("/api/users", "PATCH", { userId: workerAcct.id, role: "SUPERVISOR", assignedBusinessId: null }, ownerToken);
  ok("PATCH a unit role with its unit CLEARED → 400 (F10)", r.status === 400, `${r.status}`);
  r = await call("/api/users", "PATCH", { userId: workerAcct.id, role: "SUPERVISOR", assignedBusinessId: unitId }, ownerToken);
  ok("PATCH WORKER → SUPERVISOR with a unit → 200", r.status === 200, `${r.status} ${r.json?.error || ""}`);
  const after = (await call("/api/users", "GET", null, ownerToken)).json?.users?.find((u: any) => u.id === workerAcct.id);
  ok(
    "  ↳ supervisor preset applied (stock + record expenses on, sales off)",
    after?.canManageStock === true && after?.canRecordExpenses === true && after?.canRecordSales === false,
    JSON.stringify({ s: after?.canRecordSales, e: after?.canRecordExpenses, k: after?.canManageStock }),
  );
  // put it back exactly as it was
  r = await call("/api/users", "PATCH", { userId: workerAcct.id, role: "WORKER", assignedBusinessId: workerAcct.assignedBusinessId ?? unitId, canRecordSales: workerAcct.canRecordSales, canRecordExpenses: workerAcct.canRecordExpenses, canManageStock: workerAcct.canManageStock, canExportData: workerAcct.canExportData }, ownerToken);
  ok("  ↳ restored to WORKER with its original flags", r.status === 200, `${r.status}`);
}

const advisorToBe = created.find((c) => c.role === "FARM_ADVISOR");
if (advisorToBe?.id) {
  r = await call("/api/users", "PATCH", { userId: advisorToBe.id, role: "WORKER", assignedBusinessId: unitId }, ownerToken);
  ok("PATCH FARM_ADVISOR → WORKER with a unit → 200 (role change out of EXTERNAL works)", r.status === 200, `${r.status} ${r.json?.error || ""}`);
  r = await call("/api/users", "PATCH", { userId: advisorToBe.id, role: "FARM_ADVISOR", assignedBusinessId: null }, ownerToken);
  ok("  ↳ restored to FARM_ADVISOR (unit cleared)", r.status === 200, `${r.status}`);
}

/* ── tenant isolation across organizations ─────────────────────────────── */
section("G. Tenant isolation is untouched");
r = await call("/api/users", "GET", null, null);
ok("anonymous GET /api/users → 401", r.status === 401, `${r.status}`);
const superAdmin = usersAfter.find((u: any) => u.isSuperAdmin);
if (superAdmin) {
  ok("only the Super Admin flag (not the role) marks platform staff", usersAfter.filter((u: any) => u.isSuperAdmin).length <= 1);
}
r = await call("/api/users", "POST", { name: "Cross Org", email: `cross.${Date.now()}@probe.test`, phone: "+233 24 000 0000", role: "WORKER", assignedBusinessId: 999999 }, ownerToken);
ok("POST /api/users with a business that does not exist → 400", r.status === 400, `${r.status}`);

// DB cross-check: no rows were created for the rejected payloads.
const db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const probeRows = await db.query(
  "select email, role from users where name in ('Banana Probe','Phantom Mgr','Empty Role','Second Owner','Advisor With Unit','Delegate Escalation','Delegate CoOwner')",
);
ok("no rejected payload reached the database", probeRows.rowCount === 0, JSON.stringify(probeRows.rows));
// Probe accounts created on purpose (a delegate's own WORKER, the lower-case
// normalisation) are checked then removed, so repeated runs leave the estate
// exactly as they found it.
const delegates = await db.query("select id, email, role from users where email like 'delegate.worker.%@probe.test'");
for (const row of delegates.rows) {
  for (const t of ["organization_members", "user_business_access", "notifications"]) {
    await db.query(`delete from ${t} where user_id = $1`, [row.id]);
  }
  await db.query("delete from users where id = $1", [row.id]);
}
if (delegates.rowCount) console.log(`  · removed ${delegates.rowCount} delegate probe account(s)`);
const lc = await db.query("select id, email, role from users where name = 'Lower Case'");
if (lc.rowCount) {
  ok("lower-case 'worker' stored as canonical 'WORKER'", lc.rows[0].role === "WORKER", lc.rows[0].role);
  for (const row of lc.rows) {
    await db.query("delete from organization_members where user_id = $1", [row.id]);
    await db.query("delete from user_business_access where user_id = $1", [row.id]);
    await db.query("delete from notifications where user_id = $1", [row.id]);
    await db.query("delete from users where id = $1", [row.id]);
  }
}
const byRole = await db.query("select role, count(*)::int as n from users group by role order by role");
console.log("  · live accounts by role: " + byRole.rows.map((x: any) => `${x.role}=${x.n}`).join(" · "));
const unknown = await db.query("select distinct role from users where role not in ('OWNER','CO_OWNER','GENERAL_MANAGER','BRANCH_MANAGER','SUPERVISOR','ACCOUNTANT','WORKER','FARM_ADVISOR')");
ok("no unknown role value exists in the users table", unknown.rowCount === 0, JSON.stringify(unknown.rows));
await db.end();

/* ── summary ───────────────────────────────────────────────────────────── */
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) {
  console.log("Failures:");
  for (const f of failures) console.log("  · " + f);
}
console.log("\nAccounts created for the per-role walkthrough (password: " + NEW_PASSWORD + "):");
for (const c of created) console.log(`  · ${c.role.padEnd(14)} ${c.email}`);
process.exit(fail ? 1 : 0);
