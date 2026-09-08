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
import { eq } from "drizzle-orm";
import { getSessionInfo, accessibleBusinessIds, filterByAccess } from "@/lib/auth";

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
    const allowed = await accessibleBusinessIds(me); // null ⇒ OWNER (all)
    const isExecutive = me.role === "OWNER" || me.role === "GENERAL_MANAGER";

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
    const scopedUsers = (isExecutive
      ? allUsers
      : allUsers.filter(
          (u) =>
            u.id === me.id ||
            (u.assignedBusinessId != null && allowed!.includes(Number(u.assignedBusinessId)))
        )
    ).map(stripSecret);

    const scopedScenarios =
      allowed === null
        ? allScenarios
        : allScenarios.filter(
            (s: any) => s.targetBusinessId != null && allowed.includes(Number(s.targetBusinessId))
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

    return NextResponse.json({
      success: true,
      accessibleBusinessIds: allowed,
      businesses: scopedBusinesses,
      companyLogo: (await db.select().from(companySettings).where(eq(companySettings.id, 1)))[0]?.companyLogo || null,
      metrics: filterByAccess(allMetrics, allowed),
      users: scopedUsers,
      customers: (allowed === null ? allCustomers : allCustomers.filter(
        (c: any) => c.businessId == null || allowed.includes(Number(c.businessId))
      )).map(withCredit),
      creditSales: scopedCreditSales,
      suppliers: allSuppliers, // enterprise-shared supplier directory
      employees: filterByAccess(allEmployees, allowed),
      assets: filterByAccess(allAssets, allowed),
      inventory: filterByAccess(allInventory, allowed),
      transactions: filterByAccess(allTransactions, allowed),
      aiInsights: filterByAccess(allAiInsights, allowed),
      scenarios: scopedScenarios,
      integrations: allIntegrations,
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
