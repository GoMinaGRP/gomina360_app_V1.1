import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  users,
  businesses,
  businessMetrics,
  customers,
  suppliers,
  employees,
  assets,
  inventoryItems,
  transactions,
  creditSales,
  poultryLogs,
  blockFactoryLogs,
  aquacultureLogs,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  hardwareLogs,
  aiInsights,
  scenarioSimulations,
  integrations,
  checklistTemplates,
  checklistEntries,
  companySettings,
} from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { eq, inArray } from "drizzle-orm";
import { getSessionInfo, accessibleBusinessIds, filterByAccess } from "@/lib/auth";
import { organizations, organizationMembers } from "@/db/schema";
import { allowedBusinessTypesOfOrg } from "@/lib/businessTypes";

export async function GET(request: Request) {
  try {
    // Run seed if database is empty
    await seedDatabase();

    // ── Secure login gate ───────────────────────────────────────────────
    // Every byte of data returned below is scoped to the signed-in user.
    const session = await getSessionInfo(request);
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Sign in required." },
        { status: 401 }
      );
    }
    const me = session.user;
    const allowed = await accessibleBusinessIds(me); // null ⇒ Super Admin (all)
    const isExecutive = me.role === "OWNER" || me.role === "GENERAL_MANAGER";
    const myOrgs: number[] = me.isSuperAdmin ? [] : (me.organizationIds || (session.orgId ? [session.orgId] : []));
    // Rows whose tenant is carried in .ownerId (shared/global tables):
    // Super Admin ⇒ all; everyone else ⇒ only their own organization(s).
    const inMyOrg = (ownerId: any) => me.isSuperAdmin || myOrgs.includes(Number(ownerId));

    const allBusinesses = await db.select().from(businesses).orderBy(businesses.id);
    const allMetrics = await db.select().from(businessMetrics);
    const allUsers = await db.select().from(users).orderBy(users.id);
    const allCustomers = await db.select().from(customers);
    const allSuppliers = await db.select().from(suppliers);
    const allEmployees = await db.select().from(employees);
    const allAssets = await db.select().from(assets);
    const allInventory = await db.select().from(inventoryItems);
    const allTransactions = await db.select().from(transactions);
    const allCreditSales = await db.select().from(creditSales);
    const allAiInsights = await db.select().from(aiInsights);
    const allScenarios = await db.select().from(scenarioSimulations);
    const allIntegrations = await db.select().from(integrations);
    // Unified enterprise daily checklists (master items + dated completions)
    const allChecklistTemplates = await db.select().from(checklistTemplates);
    const allChecklistEntries = await db.select().from(checklistEntries);

    // Specialized logs
    const poultry = await db.select().from(poultryLogs);
    const blockFactory = await db.select().from(blockFactoryLogs);
    const aquaculture = await db.select().from(aquacultureLogs);
    const livestock = await db.select().from(livestockLogs);
    const restaurant = await db.select().from(restaurantLogs);
    const electronics = await db.select().from(electronicsLogs);
    const carWash = await db.select().from(carWashLogs);
    const hardware = await db.select().from(hardwareLogs);

    // ── Scope everything to the user's accessible businesses ────────────
    const scopedBusinesses =
      allowed === null
        ? allBusinesses
        : allBusinesses.filter((b) => allowed.includes(b.id));
    // Login users visible to this user: executives get the full directory;
    // managers/workers see only accounts sharing their accessible businesses.
    // Sensitive auth fields are NEVER exposed.
    const stripSecret = (u: any) => {
      const { passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe } = u;
      return safe;
    };
    // User directory: Super Admin ⇒ everyone; org executives ⇒ members of
    // their OWN organization(s) only; others ⇒ same-business accounts.
    let execMemberIds: Set<number> | null = null;
    if (isExecutive && !me.isSuperAdmin) {
      const memberRows = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, myOrgs.length ? myOrgs : [-1]));
      execMemberIds = new Set(memberRows.map((m) => Number(m.userId)));
    }
    const scopedUsers = (isExecutive
      ? (me.isSuperAdmin ? allUsers : allUsers.filter((u) => u.id === me.id || execMemberIds!.has(u.id)))
      : allUsers.filter(
          (u) =>
            u.id === me.id ||
            (u.assignedBusinessId != null && allowed!.includes(Number(u.assignedBusinessId)))
        )
    ).map(stripSecret);

    // Scenario simulations: business-targeted ones follow business scope;
    // un-targeted ("all businesses") ones belong to the owner's organization.
    const scopedScenarios =
      allowed === null
        ? allScenarios
        : allScenarios.filter(
            (s: any) =>
              (s.targetBusinessId != null && allowed.includes(Number(s.targetBusinessId))) ||
              (s.targetBusinessId == null && inMyOrg(s.ownerId))
          );

    // Credit sales (branch-isolated) + per-customer credit position, so the
    // CRM shows who owes what without another round-trip.
    const scopedCreditSales = filterByAccess(allCreditSales, allowed);
    const creditByCustomer = new Map<number, { count: number; total: number; outstanding: number }>();
    for (const cs of scopedCreditSales) {
      if (cs.customerId == null) continue;
      const agg = creditByCustomer.get(cs.customerId) || { count: 0, total: 0, outstanding: 0 };
      agg.count += 1;
      agg.total += Number(cs.totalGhs) || 0;
      agg.outstanding += Number(cs.balanceGhs) || 0;
      creditByCustomer.set(cs.customerId, agg);
    }
    const withCredit = (c: any) => {
      const agg = creditByCustomer.get(c.id);
      return {
        ...c,
        creditSalesCount: agg?.count || 0,
        creditTotalGhs: Math.round((agg?.total || 0) * 100) / 100,
        creditOutstandingGhs: Math.round((agg?.outstanding || 0) * 100) / 100,
      };
    };

    // Per-organization settings: the fallback company logo resolves from the
    // caller's OWN organization (Super Admin ⇒ their primary org).
    const orgIdForSettings = me.isSuperAdmin ? (session.orgId ?? 1) : (session.orgId ?? myOrgs[0] ?? null);
    const companyLogoRow = orgIdForSettings != null
      ? (await db.select().from(companySettings).where(eq(companySettings.organizationId, orgIdForSettings)))[0]
      : null;
    // Current organization context for the UI (null only for orphan users).
    const myOrgRow = orgIdForSettings != null
      ? (await db.select().from(organizations).where(eq(organizations.id, orgIdForSettings)))[0]
      : null;
    // Super Admin platform view: the organization directory for the admin console.
    const orgDirectory = me.isSuperAdmin ? await db.select().from(organizations).orderBy(organizations.id) : [];

    // Allowed Business Types of the caller's organization (drives both the UI
    // category pickers and the server-side creation gate). Super Admin ⇒ all.
    const allowedBizTypes = await allowedBusinessTypesOfOrg(me.isSuperAdmin ? null : orgIdForSettings);

    return NextResponse.json({
      success: true,
      accessibleBusinessIds: allowed,
      isSuperAdmin: !!me.isSuperAdmin,
      organization: myOrgRow ? { id: myOrgRow.id, name: myOrgRow.name, slug: myOrgRow.slug, status: myOrgRow.status } : null,
      organizations: orgDirectory.map((o) => ({ id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.createdAt })),
      allowedBusinessTypes: {
        restricted: allowedBizTypes.restricted,
        types: allowedBizTypes.labelsAndKeys,
      },
      businesses: scopedBusinesses,
      companyLogo: companyLogoRow?.companyLogo || null,
      metrics: filterByAccess(allMetrics, allowed),
      users: scopedUsers,
      customers: (allowed === null ? allCustomers : allCustomers.filter(
        (c: any) => (c.businessId == null ? inMyOrg(c.ownerId) : allowed.includes(Number(c.businessId)))
      )).map(withCredit),
      creditSales: scopedCreditSales,
      suppliers: allSuppliers.filter((s: any) => inMyOrg(s.ownerId)), // per-organization supplier directory
      employees: filterByAccess(allEmployees, allowed),
      assets: filterByAccess(allAssets, allowed),
      inventory: filterByAccess(allInventory, allowed),
      transactions: filterByAccess(allTransactions, allowed),
      aiInsights: (allowed === null ? allAiInsights : allAiInsights.filter(
        (i: any) => (i.businessId == null ? inMyOrg(i.ownerId) : allowed.includes(Number(i.businessId)))
      )),
      scenarios: scopedScenarios,
      integrations: allIntegrations.filter((i: any) => inMyOrg(i.ownerId)),
      checklists: {
        templates: filterByAccess(allChecklistTemplates, allowed),
        entries: filterByAccess(allChecklistEntries, allowed),
      },
      specializedLogs: {
        poultry: filterByAccess(poultry, allowed),
        blockFactory: filterByAccess(blockFactory, allowed),
        aquaculture: filterByAccess(aquaculture, allowed),
        livestock: filterByAccess(livestock, allowed),
        restaurant: filterByAccess(restaurant, allowed),
        electronics: filterByAccess(electronics, allowed),
        carWash: filterByAccess(carWash, allowed),
        hardware: filterByAccess(hardware, allowed),
      },
    });
  } catch (error: any) {
    console.error("Error in /api/init:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to initialize database" },
      { status: 500 }
    );
  }
}
