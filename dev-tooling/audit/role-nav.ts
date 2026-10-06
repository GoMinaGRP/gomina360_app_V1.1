import { navEntriesFor, navCtx } from "../../src/lib/navManifest";

const ROLES = ["OWNER", "CO_OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT", "WORKER", "FARM_ADVISOR"];

// A user exactly as /api/users POST would create them: only OWNER-granted flags
// are false, but the not-null DB defaults apply (canRecordSales=true etc.).
const baseUser = (role: string) => ({
  id: 99, role, isSuperAdmin: false, canManageUsers: false, canViewFinance: false,
  canManageSupport: false, canManageCctv: false, canManageAuditors: false,
  canExportData: role === "OWNER" || role === "GENERAL_MANAGER",
  businessManageIds: [], assignedBusinessId: null,
});

console.log("  Nav rows visible to a FRESHLY CREATED user of each role:");
console.log("  (assignedBusinessId set for branch-scoped roles; no OWNER grants)");
const out: Record<string, string[]> = {};
for (const role of ROLES) {
  const u: any = baseUser(role);
  if (role !== "FARM_ADVISOR") u.assignedBusinessId = 1;
  const entries = navEntriesFor(navCtx(u));
  out[role] = entries.map((e) => e.id);
  console.log(`  ${role.padEnd(16)} ${String(entries.length).padStart(2)} rows: ${out[role].join(", ")}`);
}

// Which rows differ between roles — the sensitive set
console.log("\n  Rows each role has that OWNER-less workers don't:");
const all = [...new Set(Object.values(out).flat())];
for (const e of all) {
  const who = ROLES.filter((r) => out[r].includes(e));
  if (who.length < ROLES.length) console.log(`    ${e.padEnd(22)} ${who.join(", ") || "—"}`);
}
