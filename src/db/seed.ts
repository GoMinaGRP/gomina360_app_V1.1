import { db } from "./index"
import { computeScenarioBaseline, computeScenarioImpacts } from "../lib/scenarioEngine";
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
  poultryLogs,
  poultryFlocks,
  poultryFeedLogs,
  poultryWaterLogs,
  poultryHealthRecords,
  poultryProduction,
  poultryChecklists,
  blockFactoryLogs,
  aquacultureLogs,
  livestockLogs,
  restaurantLogs,
  electronicsLogs,
  carWashLogs,
  aiInsights,
  scenarioSimulations,
  integrations,
  cctvCameras,
  payrollRuns,
  payrollEntries,
  payrollAttendance,
  payrollStatutoryConfig,
  companySettings,
  employeeHistory,
  auditAssignments,
  auditReviews,
  auditIssueUpdates,
  auditTrail,
  notifications,
  checklistTemplates,
  checklistEntries,
} from "./schema";
import { sql, eq } from "drizzle-orm";
import { provisionBusiness, ensureCarWashServiceCatalogue } from "@/lib/businessProvisioning";

/** Auto Car Wash service catalogue for the seeded WASH-01 unit. Idempotent:
 *  the provisioning helper is a no-op once any services exist for the unit. */
async function ensureWashFlagshipCatalogue() {
  const [wash] = await db.select().from(businesses).where(eq(businesses.code, "WASH-01"));
  if (!wash) return;
  const created = await ensureCarWashServiceCatalogue({
    id: wash.id,
    code: wash.code,
    category: wash.category,
  });
  if (created > 0) console.log(`WASH-01 service catalogue provisioned (${created} default services).`);
}

/**
 * Hardware & Building Materials flagship unit. Runs on EVERY seed pass —
 * fresh databases get it right after the seven core branches, and
 * pre-existing databases are repaired forward when the type is introduced.
 * Idempotent: no-ops once HARDWARE-01 exists, so OWNER edits (rename,
 * manager, capital) are never clobbered on later boots.
 */
async function ensureHardwareFlagship() {
  const existing = await db.select().from(businesses).where(eq(businesses.code, "HARDWARE-01"));
  if (existing.length > 0) return;
  const [biz] = await db
    .insert(businesses)
    .values({
      name: "GoMina Hardware & Building Materials Depot",
      code: "HARDWARE-01",
      category: "Hardware Store",
      branchLocation: "Asokwa Industrial Area, Kumasi",
      region: "Ashanti",
      managerName: "Kwadwo Boateng",
      contactPhone: "+233 20 880 4567",
      status: "ACTIVE",
      initialCapitalGhs: 320000,
      monthlyTargetRevenueGhs: 180000,
      iconName: "HardHat",
    })
    .returning();
  // Recovery/demo seed: zero-based metrics, the full daily-checklist template
  // set AND the Hardware starter inventory kit (starterKit is seed-only —
  // units created from the live app start completely clean per owner policy).
  await provisionBusiness(
    {
      id: biz.id,
      code: biz.code,
      name: biz.name,
      category: biz.category,
      initialCapitalGhs: biz.initialCapitalGhs,
    },
    { starterKit: true },
  );
  // General Manager visibility sweep — mirrors the core-branch grants, so the
  // GM can open the new unit from day one (revocable in Users & Access).
  await db.execute(sql`
    INSERT INTO user_business_access (user_id, business_id, created_by_user_id)
    SELECT 2, ${biz.id}, 1
    WHERE EXISTS (SELECT 1 FROM users WHERE id = 2 AND role = 'GENERAL_MANAGER')
      AND NOT EXISTS (
        SELECT 1 FROM user_business_access g
        WHERE g.user_id = 2 AND g.business_id = ${biz.id}
      )
  `);
  console.log("Hardware flagship unit provisioned: HARDWARE-01");
}

export async function seedDatabase() {
  console.log("Starting database seeding for GoMina 360 Command Center...");

  // Check if businesses are already seeded
  const existingBusinesses = await db.select().from(businesses);
  if (existingBusinesses.length > 0) {
    console.log("Database already seeded with GoMina 360 data.");
    await ensureHardwareFlagship();
    await ensureWashFlagshipCatalogue();
    return;
  }

  // 1. Insert 7 Businesses
  const insertedBusinesses = await db
    .insert(businesses)
    .values([
      {
        name: "Mina Akuafo Poultry Farm",
        code: "POULTRY-01",
        category: "Poultry Farm",
        branchLocation: "Nsawam & Kasoa Highway",
        region: "Eastern / Central Region",
        managerName: "Emmanuel Osei",
        contactPhone: "+233 24 456 7801",
        status: "ACTIVE",
        initialCapitalGhs: 180000,
        monthlyTargetRevenueGhs: 95000,
        iconName: "Egg",
      },
      {
        name: "Mina Concrete & Blocks",
        code: "BLOCK-01",
        category: "Block Factory",
        branchLocation: "Spintex Road & Tema Heavy Industrial",
        region: "Greater Accra",
        managerName: "Kofi Boahen",
        contactPhone: "+233 20 892 1104",
        status: "ACTIVE",
        initialCapitalGhs: 320000,
        monthlyTargetRevenueGhs: 145000,
        iconName: "Blocks",
      },
      {
        name: "Mina Volta Tilapia & Catfish",
        code: "AQUA-01",
        category: "Aquaculture",
        branchLocation: "Akosombo River Basin & Sogakope",
        region: "Eastern / Volta Region",
        managerName: "Dr. Selorm Gbeho",
        contactPhone: "+233 54 331 9900",
        status: "EXPANDING",
        initialCapitalGhs: 250000,
        monthlyTargetRevenueGhs: 110000,
        iconName: "Fish",
      },
      {
        name: "Mina Cattle & Small Ruminants",
        code: "LIVESTOCK-01",
        category: "Livestock",
        branchLocation: "Ashaiman Grazing Zone & Kwahu Plains",
        region: "Greater Accra / Eastern",
        managerName: "Alhaji Ibrahim Dauda",
        contactPhone: "+233 24 908 1234",
        status: "ACTIVE",
        initialCapitalGhs: 210000,
        monthlyTargetRevenueGhs: 80000,
        iconName: "Cow",
      },
      {
        name: "Mina Heritage Kitchen",
        code: "FOOD-01",
        category: "Restaurant & Food",
        branchLocation: "Osu Oxford Street & East Legon",
        region: "Greater Accra",
        managerName: "Chef Esi Mensah",
        contactPhone: "+233 27 771 8844",
        status: "ACTIVE",
        initialCapitalGhs: 150000,
        monthlyTargetRevenueGhs: 125000,
        iconName: "Utensils",
      },
      {
        name: "Mina Tech & Electronics Hub",
        code: "TECH-01",
        category: "Electronic Shop",
        branchLocation: "Kwame Nkrumah Circle & Adabraka Showroom",
        region: "Greater Accra",
        managerName: "Richmond Addo",
        contactPhone: "+233 55 670 9988",
        status: "ACTIVE",
        initialCapitalGhs: 450000,
        monthlyTargetRevenueGhs: 220000,
        iconName: "Cpu",
      },
      {
        name: "Mina Express Auto Wash",
        code: "WASH-01",
        category: "Car Wash",
        branchLocation: "Dzorwulu & Airport Residential",
        region: "Greater Accra",
        managerName: "Yaw Tetteh",
        contactPhone: "+233 24 112 3344",
        status: "ACTIVE",
        initialCapitalGhs: 95000,
        monthlyTargetRevenueGhs: 60000,
        iconName: "Droplets",
      },
    ])
    .returning();

  const businessMap: Record<string, number> = {};
  insertedBusinesses.forEach((b) => {
    businessMap[b.code] = b.id;
  });

  // 2. Insert Users (Owner, General Manager, Branch Managers)
  await db.insert(users).values([
    {
      name: "Kwame Mina",
      email: "kwame.owner@gomina360.com",
      role: "OWNER",
      assignedBusinessId: null, // access all 7 businesses
      phone: "+233 24 000 0360",
      avatarUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Abena Serwaa",
      email: "abena.gm@gomina360.com",
      role: "GENERAL_MANAGER",
      assignedBusinessId: null,
      phone: "+233 54 111 2233",
      avatarUrl: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Emmanuel Osei",
      email: "emmanuel@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["POULTRY-01"],
      phone: "+233 24 456 7801",
      avatarUrl: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Kofi Boahen",
      email: "kofi@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["BLOCK-01"],
      phone: "+233 20 892 1104",
      avatarUrl: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Dr. Selorm Gbeho",
      email: "selorm@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["AQUA-01"],
      phone: "+233 54 331 9900",
      avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Alhaji Ibrahim Dauda",
      email: "ibrahim@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["LIVESTOCK-01"],
      phone: "+233 24 908 1234",
      avatarUrl: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Chef Esi Mensah",
      email: "esi@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["FOOD-01"],
      phone: "+233 27 771 8844",
      avatarUrl: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Richmond Addo",
      email: "richmond@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["TECH-01"],
      phone: "+233 55 670 9988",
      avatarUrl: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&auto=format&fit=crop",
      isActive: true,
    },
    {
      name: "Yaw Tetteh",
      email: "yaw@gomina360.com",
      role: "BRANCH_MANAGER",
      assignedBusinessId: businessMap["WASH-01"],
      phone: "+233 24 112 3344",
      avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop",
      isActive: true,
    },
  ]);

  // 2b. Insert WORKER (Sales Person) accounts across branches
  // Manager user IDs: 3=Emmanuel(POULTRY), 4=Kofi(BLOCK), 5=Selorm(AQUA), 6=Ibrahim(LIVESTOCK), 7=Esi(FOOD), 8=Richmond(TECH), 9=Yaw(WASH)
  await db.insert(users).values([
    // Poultry Farm Workers (Manager: Emmanuel Osei, ID=3)
    {
      name: "Akua Donkor",
      email: "akua.donkor@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["POULTRY-01"],
      phone: "+233 24 700 8811",
      avatarUrl: "https://images.unsplash.com/photo-1597223557154-721c1cecc4b0?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 3,
      canRecordSales: true,
      canRecordExpenses: false,
      canManageStock: true,
    },
    {
      name: "Kwabena Mensah",
      email: "kwabena.mensah@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["POULTRY-01"],
      phone: "+233 20 881 9922",
      avatarUrl: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 3,
      canRecordSales: true,
      canRecordExpenses: true,
      canManageStock: false,
    },
    // Block Factory Workers (Manager: Kofi Boahen, ID=4)
    {
      name: "Adjei Tawiah",
      email: "adjei.tawiah@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["BLOCK-01"],
      phone: "+233 54 332 0011",
      avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 4,
      canRecordSales: true,
      canRecordExpenses: true,
      canManageStock: true,
    },
    // Aquaculture Workers (Manager: Dr. Selorm Gbeho, ID=5)
    {
      name: "Comfort Agbenyega",
      email: "comfort.agbenyega@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["AQUA-01"],
      phone: "+233 27 445 6677",
      avatarUrl: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 5,
      canRecordSales: true,
      canRecordExpenses: false,
      canManageStock: true,
    },
    // Livestock Workers (Manager: Alhaji Ibrahim Dauda, ID=6)
    {
      name: "Sulemana Abubakar",
      email: "sulemana.abubakar@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["LIVESTOCK-01"],
      phone: "+233 24 998 7766",
      avatarUrl: "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 6,
      canRecordSales: true,
      canRecordExpenses: false,
      canManageStock: false,
    },
    // Restaurant Workers (Manager: Chef Esi Mensah, ID=7)
    {
      name: "Ama Serwaa Bonsu",
      email: "ama.serwaa@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["FOOD-01"],
      phone: "+233 54 221 3344",
      avatarUrl: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 7,
      canRecordSales: true,
      canRecordExpenses: true,
      canManageStock: true,
    },
    {
      name: "Kofi Asante",
      email: "kofi.asante@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["FOOD-01"],
      phone: "+233 20 556 7788",
      avatarUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: false, // Disabled by manager
      createdByUserId: 7,
      canRecordSales: true,
      canRecordExpenses: false,
      canManageStock: false,
    },
    // Electronics Shop Workers (Manager: Richmond Addo, ID=8)
    {
      name: "Priscilla Nyarko",
      email: "priscilla.nyarko@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["TECH-01"],
      phone: "+233 55 880 9911",
      avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 8,
      canRecordSales: true,
      canRecordExpenses: true,
      canManageStock: true,
    },
    // Car Wash Workers (Manager: Yaw Tetteh, ID=9)
    {
      name: "Michael Dankwa",
      email: "michael.dankwa@gomina360.com",
      role: "WORKER",
      assignedBusinessId: businessMap["WASH-01"],
      phone: "+233 24 334 5566",
      avatarUrl: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&auto=format&fit=crop",
      isActive: true,
      isWorkerEnabled: true,
      createdByUserId: 9,
      canRecordSales: true,
      canRecordExpenses: false,
      canManageStock: false,
    },
  ]);

  // 2c. Seed initial sign-in credentials + GM enterprise visibility.
  // Fresh databases must be self-contained: without this, no account could
  // sign in at all (login requires a password hash). Idempotent by design —
  // only fills accounts whose password_hash is still NULL so it NEVER
  // clobbers passwords the OWNER rotated later, and only adds grants that
  // are missing.
  const { scryptSync, randomBytes } = await import("crypto");
  const seedPw = (pw: string) => {
    const salt = randomBytes(16).toString("hex");
    return `scrypt:${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
  };
  const seededUsers = await db
    .select({ id: users.id, role: users.role })
    .from(users);
  for (const su of seededUsers) {
    // Documented factory credentials (OWNER must rotate after first sign-in):
    //   OWNER          → Owner@GoMina26
    //   everyone else  → GoMina@User<their id>
    const initial = su.role === "OWNER" ? "Owner@GoMina26" : `GoMina@User${su.id}`;
    await db.execute(
      sql`UPDATE users SET password_hash = ${seedPw(initial)}, password_changed_at = NOW()
          WHERE id = ${su.id} AND password_hash IS NULL`
    );
  }
  // General Manager starts with visibility of every unit via revocable grants
  // (the "+7 extra branch(es)" baseline shown in Users & Access).
  await db.execute(sql`
    INSERT INTO user_business_access (user_id, business_id, created_by_user_id)
    SELECT 2, b.id, 1 FROM businesses b
    WHERE EXISTS (SELECT 1 FROM users WHERE id = 2 AND role = 'GENERAL_MANAGER')
      AND NOT EXISTS (
        SELECT 1 FROM user_business_access g
        WHERE g.user_id = 2 AND g.business_id = b.id
      )
  `);

  // 3. Insert Business Performance Metrics for 2026-Q1
  await db.insert(businessMetrics).values([
    {
      businessId: businessMap["POULTRY-01"],
      period: "2026-Q1",
      revenueGhs: 104500,
      expensesGhs: 68200,
      netProfitGhs: 36300,
      roiPercent: 20.1,
      cashFlowGhs: 24500,
      assetsValueGhs: 290000,
      inventoryValueGhs: 42000,
      growthRatePercent: 14.2,
      riskScore: 28, // Low risk
    },
    {
      businessId: businessMap["BLOCK-01"],
      period: "2026-Q1",
      revenueGhs: 158000,
      expensesGhs: 102000,
      netProfitGhs: 56000,
      roiPercent: 17.5,
      cashFlowGhs: 38000,
      assetsValueGhs: 480000,
      inventoryValueGhs: 65000,
      growthRatePercent: 18.5,
      riskScore: 35, // Medium-low risk
    },
    {
      businessId: businessMap["AQUA-01"],
      period: "2026-Q1",
      revenueGhs: 122400,
      expensesGhs: 74800,
      netProfitGhs: 47600,
      roiPercent: 19.0,
      cashFlowGhs: 31200,
      assetsValueGhs: 340000,
      inventoryValueGhs: 58000,
      growthRatePercent: 24.8,
      riskScore: 32, // Low risk
    },
    {
      businessId: businessMap["LIVESTOCK-01"],
      period: "2026-Q1",
      revenueGhs: 88500,
      expensesGhs: 54000,
      netProfitGhs: 34500,
      roiPercent: 16.4,
      cashFlowGhs: 22000,
      assetsValueGhs: 380000,
      inventoryValueGhs: 72000,
      growthRatePercent: 11.6,
      riskScore: 24, // Low risk
    },
    {
      businessId: businessMap["FOOD-01"],
      period: "2026-Q1",
      revenueGhs: 138900,
      expensesGhs: 91400,
      netProfitGhs: 47500,
      roiPercent: 31.6,
      cashFlowGhs: 41000,
      assetsValueGhs: 210000,
      inventoryValueGhs: 28000,
      growthRatePercent: 22.4,
      riskScore: 19, // Very low risk
    },
    {
      businessId: businessMap["TECH-01"],
      period: "2026-Q1",
      revenueGhs: 248000,
      expensesGhs: 164000,
      netProfitGhs: 84000,
      roiPercent: 18.6,
      cashFlowGhs: 62000,
      assetsValueGhs: 680000,
      inventoryValueGhs: 185000,
      growthRatePercent: 29.5,
      riskScore: 38,
    },
    {
      businessId: businessMap["WASH-01"],
      period: "2026-Q1",
      revenueGhs: 64800,
      expensesGhs: 35200,
      netProfitGhs: 29600,
      roiPercent: 31.1,
      cashFlowGhs: 26800,
      assetsValueGhs: 135000,
      inventoryValueGhs: 9500,
      growthRatePercent: 15.8,
      riskScore: 18,
    },
  ]);

  // 4. Insert Shared Customers & Suppliers
  const insertedCustomers = await db
    .insert(customers)
    .values([
      {
        name: "Shoprite & Melcom Ghana Stores",
        type: "WHOLESALE",
        phone: "+233 30 277 8899",
        email: "procurement@shopritegh.com",
        address: "Accra Central Distribution Hub",
        totalSpentGhs: 145000,
        loyaltyPoints: 1450,
        businessId: null,
      },
      {
        name: "Consolidated Real Estate & Build Co",
        type: "CORPORATE",
        phone: "+233 24 555 9090",
        email: "site@consolidatedbuild.gh",
        address: "Cantonments & Spintex Projects",
        totalSpentGhs: 210000,
        loyaltyPoints: 2100,
        businessId: businessMap["BLOCK-01"],
      },
      {
        name: "Labadi Beach Hotel & Resorts",
        type: "WHOLESALE",
        phone: "+233 30 277 2500",
        email: "kitchen@labadibeachhotel.gh",
        address: "La Road, Accra",
        totalSpentGhs: 96000,
        loyaltyPoints: 960,
        businessId: null,
      },
      {
        name: "Nana Kwame Appiah",
        type: "RETAIL",
        phone: "+233 54 888 1212",
        email: "nana.kwame@gmail.com",
        address: "East Legon, Accra",
        totalSpentGhs: 28500,
        loyaltyPoints: 285,
        businessId: businessMap["TECH-01"],
      },
    ])
    .returning();

  const insertedSuppliers = await db
    .insert(suppliers)
    .values([
      {
        name: "Ghafeed Poultry Mills Ltd",
        category: "Poultry Feed & Concentrates",
        contactPerson: "Mr. Ebenezer Ofori",
        phone: "+233 24 333 4455",
        email: "sales@ghafeed.gh",
        paymentTerms: "NET_14",
        totalSuppliedGhs: 84000,
      },
      {
        name: "Ghacem Cement Distributors Ltd",
        category: "Cement & Building Materials",
        contactPerson: "Madam Joyce Acheampong",
        phone: "+233 30 220 8080",
        email: "orders@ghacem-dist.com",
        paymentTerms: "NET_30",
        totalSuppliedGhs: 165000,
      },
      {
        name: "Akosombo Fingerlings & Aquaculture Supplies",
        category: "Fish Seed & Floating Feed",
        contactPerson: "Dr. Kojo Asare",
        phone: "+233 20 112 2299",
        email: "supplies@akosomboaqua.gh",
        paymentTerms: "CASH_ON_DELIVERY",
        totalSuppliedGhs: 62000,
      },
      {
        name: "Felicity & LG Solar Global Importers",
        category: "Electronics Import & Solar Equipment",
        contactPerson: "Stephen Wang / Akosua Dapaah",
        phone: "+233 55 990 8811",
        email: "solar@felicitygh.com",
        paymentTerms: "NET_30",
        totalSuppliedGhs: 230000,
      },
    ])
    .returning();

  // 5. Insert Employees across all branches
  await db.insert(employees).values([
    {
      name: "Doris Ansah",
      employeeNo: "EMP-0001",
      role: "Senior Farm Veterinarian",
      businessId: businessMap["POULTRY-01"],
      branch: "Nsawam Highway",
      salaryGhs: 4500,
      phone: "+233 24 667 8810",
      hireDate: "2024-03-15",
    },
    {
      name: "Samuel Kumi",
      employeeNo: "EMP-0002",
      role: "Block Molding Supervisor",
      businessId: businessMap["BLOCK-01"],
      branch: "Spintex Road",
      salaryGhs: 3800,
      phone: "+233 20 443 2211",
      hireDate: "2023-11-01",
    },
    {
      name: "George Nartey",
      employeeNo: "EMP-0003",
      role: "Water Quality & Cage Specialist",
      businessId: businessMap["AQUA-01"],
      branch: "Akosombo River Basin",
      salaryGhs: 4200,
      phone: "+233 54 991 1002",
      hireDate: "2024-01-10",
    },
    {
      name: "Kwesi Frimpong",
      employeeNo: "EMP-0004",
      role: "Ranch Overseer & Tag Logger",
      businessId: businessMap["LIVESTOCK-01"],
      branch: "Kwahu Plains",
      salaryGhs: 3500,
      phone: "+233 24 887 7766",
      hireDate: "2023-08-20",
    },
    {
      name: "Patience Osei-Bonsu",
      employeeNo: "EMP-0005",
      role: "Kitchen Manager & Cashier",
      businessId: businessMap["FOOD-01"],
      branch: "Osu Oxford Street",
      salaryGhs: 3900,
      phone: "+233 27 554 3322",
      hireDate: "2024-05-01",
    },
    {
      name: "Michael Quaye",
      employeeNo: "EMP-0006",
      role: "Solar Systems Engineer",
      businessId: businessMap["TECH-01"],
      branch: "Circle Showroom",
      salaryGhs: 5200,
      phone: "+233 55 112 9988",
      hireDate: "2023-06-15",
    },
    {
      name: "Gideon Lamptey",
      employeeNo: "EMP-0007",
      role: "Bay Coordinator & Detailer",
      businessId: businessMap["WASH-01"],
      branch: "Dzorwulu",
      salaryGhs: 2800,
      phone: "+233 24 331 4455",
      hireDate: "2024-02-12",
    },
  ]);

  // Registration history for every seeded employee (the audit trail starts
  // at registration; every later change appends rows here).
  const seededEmpIds = [1, 2, 3, 4, 5, 6, 7];
  const seededEmpNames = ["Doris Ansah", "Samuel Kumi", "George Nartey", "Kwesi Frimpong", "Patience Osei-Bonsu", "Michael Quaye", "Gideon Lamptey"];
  await db.insert(employeeHistory).values(
    seededEmpIds.map((id, i) => ({
      employeeId: id,
      businessId: i + 1, // employees 1..7 belong to businesses 1..7 in this seed
      action: "CREATED",
      summary: `Registered ${seededEmpNames[i]} (EMP-${String(id).padStart(4, "0")}) — seeded baseline`,
      changedByUserId: 1,
      changedByName: "Kwame Mina",
      changedByRole: "OWNER",
    }))
  );

  // 6. Insert Enterprise Assets & Equipment
  await db.insert(assets).values([
    {
      assetCode: "POULTRY-01-AST-0001",
      name: "John Deere 5055E Farm Tractor",
      businessId: businessMap["POULTRY-01"],
      branchCode: "POULTRY-01",
      assetType: "VEHICLE",
      purchasePriceGhs: 145000,
      currentValueGhs: 125000,
      condition: "EXCELLENT",
      location: "Nsawam Farm Yard",
      nextMaintenanceDate: "2026-05-15",
    },
    {
      assetCode: "BLOCK-01-AST-0001",
      name: "Qingdao Heavy Duty Block Molding Machine",
      businessId: businessMap["BLOCK-01"],
      branchCode: "BLOCK-01",
      assetType: "MACHINERY",
      purchasePriceGhs: 210000,
      currentValueGhs: 185000,
      condition: "EXCELLENT",
      location: "Spintex Production Bay A",
      nextMaintenanceDate: "2026-04-20",
    },
    {
      assetCode: "AQUA-01-AST-0001",
      name: "HDPE Floating River Cages (8 Units)",
      businessId: businessMap["AQUA-01"],
      branchCode: "AQUA-01",
      assetType: "STRUCTURE",
      purchasePriceGhs: 160000,
      currentValueGhs: 142000,
      condition: "EXCELLENT",
      location: "Akosombo Volta Basin Sector 4",
      nextMaintenanceDate: "2026-06-01",
    },
    {
      assetCode: "TECH-01-AST-0001",
      name: "10kVA Felicity Solar Generator & Storage Array",
      businessId: businessMap["TECH-01"],
      branchCode: "TECH-01",
      assetType: "GENERATOR",
      purchasePriceGhs: 65000,
      currentValueGhs: 59000,
      condition: "EXCELLENT",
      location: "Circle Headquarters",
      nextMaintenanceDate: "2026-07-10",
    },
    {
      assetCode: "WASH-01-AST-0001",
      name: "Kärcher Industrial 3500 PSI Pressure Washing Systems",
      businessId: businessMap["WASH-01"],
      branchCode: "WASH-01",
      assetType: "MACHINERY",
      purchasePriceGhs: 48000,
      currentValueGhs: 42000,
      condition: "GOOD",
      location: "Dzorwulu Wash Bays 1-4",
      nextMaintenanceDate: "2026-04-10",
    },
  ]);

  // 7. Insert Unified Inventory Items across businesses
  await db.insert(inventoryItems).values([
    {
      name: "Grade A Large Egg Trays (30 Eggs/Tray)",
      sku: "POUL-EGG-L01",
      businessId: businessMap["POULTRY-01"],
      category: "Poultry Products",
      quantity: 850,
      unit: "Trays",
      costPriceGhs: 38.0,
      sellingPriceGhs: 55.0,
      minStockThreshold: 150,
      status: "IN_STOCK",
    },
    {
      name: "6-Inch Solid Construction Blocks (Grade A)",
      sku: "BLK-SOLID-6IN",
      businessId: businessMap["BLOCK-01"],
      category: "Concrete Blocks",
      quantity: 4500,
      unit: "Units",
      costPriceGhs: 9.5,
      sellingPriceGhs: 14.5,
      minStockThreshold: 1000,
      status: "IN_STOCK",
    },
    {
      name: "Fresh Harvested Volta Tilapia (Average 800g)",
      sku: "AQUA-TILAP-800G",
      businessId: businessMap["AQUA-01"],
      category: "Fresh Aquaculture",
      quantity: 1200,
      unit: "Kg",
      costPriceGhs: 38.0,
      sellingPriceGhs: 62.0,
      minStockThreshold: 300,
      status: "IN_STOCK",
    },
    {
      name: "5kVA Hybrid Solar Inverter + Lithium Battery Combo",
      sku: "TECH-SOL-5KVA",
      businessId: businessMap["TECH-01"],
      category: "Solar & Energy",
      quantity: 14,
      unit: "Units",
      costPriceGhs: 9200,
      sellingPriceGhs: 13500,
      minStockThreshold: 5,
      status: "IN_STOCK",
    },
    {
      name: "Premium Auto Foam Shampoo & High-Gloss Wax Drum (50L)",
      sku: "WASH-CHEM-50L",
      businessId: businessMap["WASH-01"],
      category: "Cleaning Chemicals",
      quantity: 8,
      unit: "Drums",
      costPriceGhs: 750,
      sellingPriceGhs: 1200,
      minStockThreshold: 3,
      status: "IN_STOCK",
    },
  ]);

  // 8. Insert Multi-Channel Financial Transactions
  await db.insert(transactions).values([
    {
      transactionNumber: "TRX-2026-1001",
      businessId: businessMap["POULTRY-01"],
      type: "INCOME",
      category: "Egg Wholesale Supply",
      amountGhs: 16500,
      paymentMethod: "MTN_MOMO",
      customerId: insertedCustomers[0].id,
      supplierId: null,
      description: "Wholesale delivery of 300 trays of Grade A Eggs to Shoprite & Melcom",
      date: "2026-03-29",
      status: "COMPLETED",
      recordedBy: "Emmanuel Osei",
    },
    {
      transactionNumber: "TRX-2026-1002",
      businessId: businessMap["BLOCK-01"],
      type: "INCOME",
      category: "Block Bulk Order",
      amountGhs: 29000,
      paymentMethod: "BANK_TRANSFER",
      customerId: insertedCustomers[1].id,
      supplierId: null,
      description: "Supply of 2,000 units of 6-inch solid blocks for Spintex construction site",
      date: "2026-03-28",
      status: "COMPLETED",
      recordedBy: "Kofi Boahen",
    },
    {
      transactionNumber: "TRX-2026-1003",
      businessId: businessMap["POULTRY-01"],
      type: "EXPENSE",
      category: "Feed Concentrate Purchase",
      amountGhs: 18400,
      paymentMethod: "BANK_TRANSFER",
      customerId: null,
      supplierId: insertedSuppliers[0].id,
      description: "Monthly purchase of layer feed concentrate & multivitamins",
      date: "2026-03-26",
      status: "COMPLETED",
      recordedBy: "Abena Serwaa",
    },
    {
      transactionNumber: "TRX-2026-1004",
      businessId: businessMap["FOOD-01"],
      type: "INCOME",
      category: "Restaurant Daily Receipts",
      amountGhs: 8450,
      paymentMethod: "MTN_MOMO",
      customerId: null,
      supplierId: null,
      description: "Combined weekend dining receipts (MTN MoMo & Telecel Cash)",
      date: "2026-03-29",
      status: "COMPLETED",
      recordedBy: "Chef Esi Mensah",
    },
    {
      transactionNumber: "TRX-2026-1005",
      businessId: businessMap["TECH-01"],
      type: "INCOME",
      category: "Solar Inverter Installation",
      amountGhs: 27000,
      paymentMethod: "BANK_TRANSFER",
      customerId: insertedCustomers[3].id,
      supplierId: null,
      description: "Supply & installation of 10kVA Solar Hybrid System for residential villa",
      date: "2026-03-30",
      status: "COMPLETED",
      recordedBy: "Richmond Addo",
    },
    {
      transactionNumber: "TRX-2026-1006",
      businessId: businessMap["WASH-01"],
      type: "INCOME",
      category: "Express Car Wash Services",
      amountGhs: 2480,
      paymentMethod: "MTN_MOMO",
      customerId: null,
      supplierId: null,
      description: "Daily washing bay receipts (46 sedans & SUVs serviced)",
      date: "2026-03-30",
      status: "COMPLETED",
      recordedBy: "Yaw Tetteh",
    },
  ]);

  // --- 9. INSERT SPECIALIZED OPERATIONAL LOGS FOR EACH BUSINESS ---
  // Poultry Logs
  await db.insert(poultryLogs).values([
    {
      businessId: businessMap["POULTRY-01"],
      batchNumber: "BATCH-2026-L01",
      birdType: "LAYERS",
      totalBirds: 4200,
      dailyEggsTrays: 128,
      feedConsumedKg: 480.5,
      mortalityCount: 1,
      healthStatus: "HEALTHY",
      recordedDate: "2026-03-30",
    },
    {
      businessId: businessMap["POULTRY-01"],
      batchNumber: "BATCH-2026-B02",
      birdType: "BROILERS",
      totalBirds: 2800,
      dailyEggsTrays: 0,
      feedConsumedKg: 390.0,
      mortalityCount: 0,
      healthStatus: "VACCINATED",
      recordedDate: "2026-03-29",
    },
  ]);

  // Poultry Flocks (Flock & Batch Management)
  await db.insert(poultryFlocks).values([
    {
      businessId: businessMap["POULTRY-01"],
      branchCode: "POULTRY-01",
      branchName: "Mina Akuafo Poultry Farm",
      batchNumber: "BATCH-2026-L01",
      flockName: "Nsawam Isa Brown Layer Flock",
      birdType: "LAYERS",
      breed: "Isa Brown",
      genetics: "Isa Brown (Hy-Line Genetics)",
      supplier: "Akate Farms Hatchery Ltd",
      houseName: "House A",
      initialCount: 4300,
      currentCount: 4200,
      mortalityTotal: 100,
      arrivalDate: "2025-09-15",
      ageWeeks: 42,
      sourceHatchery: "Akate Farms Hatchery",
      costPerBirdGhs: 18.5,
      status: "ACTIVE",
      createdByName: "Emmanuel Osei",
      createdByRole: "BRANCH_MANAGER",
    },
    {
      businessId: businessMap["POULTRY-01"],
      branchCode: "POULTRY-01",
      branchName: "Mina Akuafo Poultry Farm",
      batchNumber: "BATCH-2026-B02",
      flockName: "Nsawam Cobb Broiler Batch",
      birdType: "BROILERS",
      breed: "Cobb 500",
      genetics: "Cobb 500 (Cobb-Vantress)",
      supplier: "Darko Farms Hatchery Ltd",
      houseName: "House B",
      initialCount: 3000,
      currentCount: 2800,
      mortalityTotal: 200,
      arrivalDate: "2026-06-01",
      ageWeeks: 6,
      sourceHatchery: "Darko Farms Hatchery",
      costPerBirdGhs: 12.0,
      status: "ACTIVE",
      createdByName: "Emmanuel Osei",
      createdByRole: "BRANCH_MANAGER",
    },
    {
      businessId: businessMap["POULTRY-01"],
      branchCode: "POULTRY-01",
      branchName: "Mina Akuafo Poultry Farm",
      batchNumber: "BATCH-2026-L03",
      flockName: "Kasoa Lohmann Brown Flock",
      birdType: "LAYERS",
      breed: "Lohmann Brown",
      genetics: "Lohmann Brown (Lohmann Tierzucht)",
      supplier: "Akate Farms Hatchery Ltd",
      houseName: "House C",
      initialCount: 2500,
      currentCount: 2465,
      mortalityTotal: 35,
      arrivalDate: "2026-02-20",
      ageWeeks: 24,
      sourceHatchery: "Akate Farms Hatchery",
      costPerBirdGhs: 19.0,
      status: "ACTIVE",
      createdByName: "Akua Donkor",
      createdByRole: "WORKER",
    },
  ]);

  // Block Factory Logs
  await db.insert(blockFactoryLogs).values([
    {
      businessId: businessMap["BLOCK-01"],
      batchId: "BLK-PROD-091",
      blockType: "6-INCH-SOLID",
      bagsCementUsed: 65,
      blocksMolded: 1950,
      blocksBroken: 14,
      qualityGrade: "GRADE_A_STANDARD",
      recordedDate: "2026-03-30",
    },
    {
      businessId: businessMap["BLOCK-01"],
      batchId: "BLK-PROD-090",
      blockType: "PAVING-BRICKS",
      bagsCementUsed: 40,
      blocksMolded: 2400,
      blocksBroken: 8,
      qualityGrade: "GRADE_A_STANDARD",
      recordedDate: "2026-03-29",
    },
  ]);

  // Aquaculture Logs
  await db.insert(aquacultureLogs).values([
    {
      businessId: businessMap["AQUA-01"],
      pondId: "CAGE-VOLTA-04",
      species: "VOLTA_TILAPIA",
      stockCount: 12500,
      averageWeightGrams: 740.0,
      phLevel: 7.3,
      dissolvedOxygen: 6.8,
      fcr: 1.31,
      recordedDate: "2026-03-30",
    },
    {
      businessId: businessMap["AQUA-01"],
      pondId: "POND-AKOSOMBO-02",
      species: "AFRICAN_CATFISH",
      stockCount: 8000,
      averageWeightGrams: 1100.0,
      phLevel: 7.1,
      dissolvedOxygen: 6.5,
      fcr: 1.28,
      recordedDate: "2026-03-29",
    },
  ]);

  // Livestock Logs
  await db.insert(livestockLogs).values([
    {
      businessId: businessMap["LIVESTOCK-01"],
      tagNumber: "GH-COW-104",
      animalType: "CATTLE",
      breed: "SANGA",
      weightKg: 420.5,
      vaccinationStatus: "UP_TO_DATE",
      pregnantStatus: true,
      recordedDate: "2026-03-30",
    },
    {
      businessId: businessMap["LIVESTOCK-01"],
      tagNumber: "GH-GOAT-088",
      animalType: "GOAT",
      breed: "WEST_AFRICAN_DWARF",
      weightKg: 48.0,
      vaccinationStatus: "UP_TO_DATE",
      pregnantStatus: false,
      recordedDate: "2026-03-29",
    },
  ]);

  // Restaurant Logs
  await db.insert(restaurantLogs).values([
    {
      businessId: businessMap["FOOD-01"],
      shiftDate: "2026-03-30",
      totalOrders: 184,
      mostPopularDish: "Jollof Rice with Grilled Tilapia & Pepper Sauce",
      foodCostPercent: 27.8,
      wastePercent: 2.6,
      momoReceiptsGhs: 5800,
      cashReceiptsGhs: 2650,
    },
  ]);

  // Electronics Shop Logs
  await db.insert(electronicsLogs).values([
    {
      businessId: businessMap["TECH-01"],
      serialNumber: "SN-SOL-5KVA-88190",
      productName: "5kVA Hybrid Solar Inverter + Smart BMS",
      brand: "Felicity Solar",
      warrantyMonths: 24,
      inStock: true,
      retailPriceGhs: 13500,
      lastCheckedDate: "2026-03-30",
    },
    {
      businessId: businessMap["TECH-01"],
      serialNumber: "SN-SAM-65QLED-0441",
      productName: "65-inch 4K QLED Smart TV",
      brand: "Samsung",
      warrantyMonths: 12,
      inStock: true,
      retailPriceGhs: 11200,
      lastCheckedDate: "2026-03-29",
    },
  ]);

  // Car Wash Logs
  await db.insert(carWashLogs).values([
    {
      businessId: businessMap["WASH-01"],
      shiftDate: "2026-03-30",
      vehiclesWashed: 52,
      chemicalUsedLiters: 14.5,
      totalRevenueGhs: 2860,
      waterPressurePsi: 3200,
      recordedDate: "2026-03-30",
    },
  ]);

  // 10. Insert AI Strategic Insights & Recommendations
  await db.insert(aiInsights).values([
    {
      businessId: null, // Executive / All-Business insight
      title: "Enterprise Cash Flow Optimization & High ROI Alignment",
      category: "OPPORTUNITY",
      impactLevel: "CRITICAL",
      recommendation:
        "Reinvest GH₵ 50,000 of surplus cash flow from Mina Heritage Kitchen into bulk procurement of 5kVA Solar Inverters for Mina Tech & Electronics Hub to capture peak Q2 solar demand.",
      metricAffected: "Net Profit (+GH₵ 38,500 over 60 days)",
      projectedGainGhs: 38500,
      status: "NEW",
    },
    {
      businessId: businessMap["POULTRY-01"],
      title: "Poultry Feed FCR & Bulk Concentrate Hedge",
      category: "EFFICIENCY",
      impactLevel: "HIGH",
      recommendation:
        "Lock in a 6-month contract with Ghafeed Mills at current prices. Projected maize cost inflation is +12% in June. This preserves Poultry Farm gross margin.",
      metricAffected: "Feed Cost Savings (+GH₵ 14,200)",
      projectedGainGhs: 14200,
      status: "NEW",
    },
    {
      businessId: businessMap["BLOCK-01"],
      title: "Block Breakage Reduction & Curing Optimization",
      category: "EFFICIENCY",
      impactLevel: "MEDIUM",
      recommendation:
        "Install automated misting sprays in Tema curing yard to reduce block breakage from 0.72% to under 0.30% during hot afternoons.",
      metricAffected: "Breakage Rate (-4.2%)",
      projectedGainGhs: 8900,
      status: "NEW",
    },
    {
      businessId: businessMap["AQUA-01"],
      title: "Volta Basin Tilapia Harvest Timing for Easter Peak",
      category: "FORECAST",
      impactLevel: "HIGH",
      recommendation:
        "Schedule harvest of Cage-Volta-04 three days before Easter weekend when Accra wholesale fish prices typically spike by 18% per Kg.",
      metricAffected: "Revenue Boost (+GH₵ 22,000)",
      projectedGainGhs: 22000,
      status: "NEW",
    },
  ]);

  // 11. Insert Scenario Planning & What-If Simulations
  // Scenario impacts are COMPUTED from the freshly seeded baseline via the
  // shared scenario engine (never hardcoded dummy constants).
  const seededScenarios: {
    name: string; description: string; targetBusinessId: number | null;
    variableChanged: string; percentChange: number; createdBy: string;
  }[] = [
    {
      name: "15% Poultry Feed Price Hike Stress Test",
      description:
        "Simulates impact if commercial poultry feed prices rise by 15% across Nsawam and Kasoa farms without raising egg prices.",
      targetBusinessId: businessMap["POULTRY-01"],
      variableChanged: "Feed Price",
      percentChange: 15.0,
      createdBy: "Kwame Mina",
    },
    {
      name: "Kumasi Branch Expansion for Block Factory",
      description:
        "Simulates opening a second automated concrete block factory in Kumasi with GH₵ 250,000 capital expenditure.",
      targetBusinessId: businessMap["BLOCK-01"],
      variableChanged: "New Branch Production",
      percentChange: 65.0,
      createdBy: "Abena Serwaa",
    },
    {
      name: "30% Surge in Residential Solar Inverter Demand",
      description:
        "Simulates bulk importation of 50 additional Felicity 5kVA & 10kVA Hybrid systems to satisfy Accra & Kumasi energy demand.",
      targetBusinessId: businessMap["TECH-01"],
      variableChanged: "Solar Demand",
      percentChange: 30.0,
      createdBy: "Kwame Mina",
    },
  ];
  for (const sc of seededScenarios) {
    const baseline = await computeScenarioBaseline(sc.targetBusinessId);
    const impacts = computeScenarioImpacts(sc.variableChanged, sc.percentChange, baseline);
    await db.insert(scenarioSimulations).values({
      name: sc.name,
      description: sc.description,
      targetBusinessId: sc.targetBusinessId,
      variableChanged: sc.variableChanged,
      percentChange: sc.percentChange,
      expectedRevenueImpactGhs: impacts.revenueImpact,
      expectedProfitImpactGhs: impacts.profitImpact,
      expectedRoiDelta: impacts.roiDelta,
      createdBy: sc.createdBy,
    });
  }

  // 12. Insert Future-Ready Integrations Hub
  await db.insert(integrations).values([
    {
      name: "MTN Mobile Money & Telecel Merchant API",
      category: "PAYMENTS",
      provider: "Ghana Interbank Payment & Settlement Systems (GIPSS)",
      status: "CONNECTED",
      lastSync: "Just now (Live WebSocket)",
      configJson: { merchantId: "MOMOGH-36009", instantSettlement: true },
    },
    {
      name: "Ecobank Corporate & GCB Bank Gateway",
      category: "BANKING",
      provider: "Ecobank Ghana / GCB Open Banking API",
      status: "CONNECTED",
      lastSync: "Today, 08:30 AM",
      configJson: { accountNo: "0012903844901", autoReconciliation: true },
    },
    {
      name: "Xero / QuickBooks Enterprise Cloud Sync",
      category: "ACCOUNTING",
      provider: "Xero Ghana Enterprise Integration",
      status: "CONNECTED",
      lastSync: "Yesterday, 11:45 PM",
      configJson: { currency: "GHS", taxRate: "VAT 15%" },
    },
    {
      name: "Hikvision CCTV 24/7 Cloud Security Feed",
      category: "CCTV_SECURITY",
      provider: "Hikvision Cloud Security Network (7 Branches)",
      status: "CONNECTED",
      lastSync: "Live 24/7 Feed",
      configJson: { cameraCount: 42, cloudStorageDays: 30 },
    },
    {
      name: "Smart Pond & Cage Oxygen IoT Sensors",
      category: "IOT_SENSORS",
      provider: "Volta Basin Aquaculture IoT Mesh",
      status: "CONNECTED",
      lastSync: "Live (Every 5 mins)",
      configJson: { minDissolvedOxygen: 5.5, autoAerationTrigger: true },
    },
    {
      name: "WooCommerce & Shopify E-Commerce Storefront",
      category: "POS_HARDWARE",
      provider: "Mina Electronics Online & POS Sync",
      status: "READY_TO_CONNECT",
      lastSync: "Not connected",
      configJson: { storeUrl: "https://shop.gomina360.com" },
    },
  ]);

  // 12b. CCTV Security Cameras — Business → Branch → Cameras baseline
  // (business ids follow the insertion order above: 1 Poultry, 2 Block,
  //  3 Aqua, 4 Livestock, 5 Food, 6 Tech, 7 Wash).
  await db.insert(cctvCameras).values([
    {
      businessId: 1,
      branchCode: "POULTRY-01",
      branchName: "Mina Akuafo Poultry Farm",
      name: "Yard & Feed Storage Camera",
      location: "Yard & Feed Storage — Nsawam site",
      brand: "HIKVISION",
      cameraType: "IP_CAMERA",
      model: "DS-2CD2T43G2-4I (4MP Bullet)",
      connectionType: "POE_RTSP",
      host: "192.168.10.41",
      port: 554,
      streamUrl: "rtsp://192.168.10.41:554/Streaming/Channels/101",
      username: "admin",
      status: "ONLINE",
      snapshotUrl:
        "https://images.unsplash.com/photo-1548550023-2bdb3c5beed7?w=800&auto=format&fit=crop",
      notes: "Primary yard overwatch with 30m night vision.",
      createdByName: "Kwame Mina",
    },
    {
      businessId: 2,
      branchCode: "BLOCK-01",
      branchName: "Mina Concrete & Blocks",
      name: "Production Bay A Overwatch",
      location: "Concrete Production Bay A — Spintex",
      brand: "DAHUA",
      cameraType: "IP_CAMERA",
      model: "IPC-HFW5442E-ZE (4MP Bullet)",
      connectionType: "POE_RTSP",
      host: "192.168.20.42",
      port: 554,
      streamUrl: "rtsp://192.168.20.42:554/cam/realmonitor?channel=1&subtype=0",
      username: "admin",
      status: "ONLINE",
      snapshotUrl:
        "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=800&auto=format&fit=crop",
      createdByName: "Kwame Mina",
    },
    {
      businessId: 3,
      branchCode: "AQUA-01",
      branchName: "Mina Volta Tilapia & Catfish",
      name: "Cage Array #4 PTZ",
      location: "Akosombo Volta Basin — Cage Array #4",
      brand: "UNIVIEW",
      cameraType: "PTZ_IP_CAMERA",
      model: "IPC7624EL-X55UG (4K PTZ)",
      connectionType: "WIFI",
      host: "10.8.0.24",
      port: 554,
      streamUrl: "rtsp://10.8.0.24:554/media/video1",
      username: "admin",
      status: "ONLINE",
      snapshotUrl:
        "https://images.unsplash.com/photo-1516214104703-d870798883c5?w=800&auto=format&fit=crop",
      notes: "Wireless point-to-point bridge from shore station.",
      createdByName: "Kwame Mina",
    },
    {
      businessId: 6,
      branchCode: "TECH-01",
      branchName: "Mina Tech & Electronics Hub",
      name: "Showroom Floor Dome",
      location: "Kwame Nkrumah Circle Showroom",
      brand: "HIKVISION",
      cameraType: "IP_CAMERA",
      model: "DS-2CD2143G2-I (4MP Dome)",
      connectionType: "POE_RTSP",
      host: "192.168.60.44",
      port: 554,
      streamUrl: "rtsp://192.168.60.44:554/Streaming/Channels/101",
      username: "admin",
      status: "ONLINE",
      snapshotUrl:
        "https://images.unsplash.com/photo-1558002038-1055907df827?w=800&auto=format&fit=crop",
      createdByName: "Kwame Mina",
    },
    {
      businessId: 5,
      branchCode: "FOOD-01",
      branchName: "Mina Heritage Kitchen",
      name: "Kitchen & Counter NVR",
      location: "Heritage Kitchen — Osu, back office rack",
      brand: "DAHUA",
      cameraType: "NVR_SYSTEM",
      model: "NVR4208-8P-4KS2 (8-channel PoE NVR)",
      connectionType: "NVR_CHANNEL",
      host: "192.168.50.50",
      port: 37777,
      username: "admin",
      status: "ONLINE",
      notes: "8-channel PoE NVR — channels 1–6 populated (kitchen, counter, store).",
      createdByName: "Kwame Mina",
    },
    {
      businessId: 7,
      branchCode: "WASH-01",
      branchName: "Mina Express Auto Wash",
      name: "Wash Bay DVR System",
      location: "Mina Express Auto Wash — Dzorwulu, bay wall",
      brand: "HIKVISION",
      cameraType: "DVR_SYSTEM",
      model: "DS-7208HGHI-K1 (8-ch TurboHD DVR)",
      connectionType: "COAXIAL_BNC",
      host: "192.168.70.71",
      port: 8000,
      username: "admin",
      status: "ONLINE",
      notes: "Analog coax cameras for wash bays 1–4 via the TurboHD DVR.",
      createdByName: "Kwame Mina",
    },
  ]);

  // 12c. Payroll baseline — attendance/leave/overtime + one August draft run
  // (Doris Ansah, Poultry): base 4,500 + transport allowance 250 + 3 OT hrs
  // (3 × 4,500/208 × 1.5 = 97.36) − welfare advance 150 → net 4,697.36.
  await db.insert(payrollAttendance).values([
    { employeeId: 1, employeeName: "Doris Ansah", businessId: 1, branchCode: "POULTRY-01", date: "2026-08-03", status: "PRESENT", hoursWorked: 8, overtimeHours: 0, recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 1, employeeName: "Doris Ansah", businessId: 1, branchCode: "POULTRY-01", date: "2026-08-04", status: "PRESENT", hoursWorked: 8, overtimeHours: 2, note: "Vaccination drive", recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 1, employeeName: "Doris Ansah", businessId: 1, branchCode: "POULTRY-01", date: "2026-08-05", status: "PRESENT", hoursWorked: 8, overtimeHours: 1, recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 1, employeeName: "Doris Ansah", businessId: 1, branchCode: "POULTRY-01", date: "2026-08-06", status: "LEAVE", hoursWorked: 0, overtimeHours: 0, leaveType: "ANNUAL", recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 1, employeeName: "Doris Ansah", businessId: 1, branchCode: "POULTRY-01", date: "2026-08-07", status: "PRESENT", hoursWorked: 8, overtimeHours: 0, recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 5, employeeName: "Patience Osei-Bonsu", businessId: 5, branchCode: "FOOD-01", date: "2026-08-10", status: "PRESENT", hoursWorked: 8, overtimeHours: 2, note: "Weekend event cover", recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 5, employeeName: "Patience Osei-Bonsu", businessId: 5, branchCode: "FOOD-01", date: "2026-08-11", status: "HALF_DAY", hoursWorked: 4, overtimeHours: 0, recordedByUserId: 1, recordedByName: "Kwame Mina" },
    { employeeId: 5, employeeName: "Patience Osei-Bonsu", businessId: 5, branchCode: "FOOD-01", date: "2026-08-12", status: "PRESENT", hoursWorked: 8, overtimeHours: 0, recordedByUserId: 1, recordedByName: "Kwame Mina" },
  ]);
  const [seedPayRun] = await db
    .insert(payrollRuns)
    .values({
      period: "2026-08",
      businessId: 1,
      branchCode: "POULTRY-01",
      branchName: "Mina Akuafo Poultry Farm",
      status: "DRAFT",
      notes: "August 2026 salary cycle — awaiting review",
      createdByUserId: 1,
      createdByName: "Kwame Mina",
    })
    .returning();
  await db.insert(payrollEntries).values({
    runId: seedPayRun.id,
    employeeId: 1,
    employeeName: "Doris Ansah",
    employeeRole: "Senior Farm Veterinarian",
    businessId: 1,
    branchCode: "POULTRY-01",
    baseSalaryGhs: 4500,
    allowancesGhs: 250,
    allowanceNote: "transport",
    overtimeHours: 3,
    overtimePayGhs: 97.36,
    deductionsGhs: 150,
    deductionNote: "welfare advance",
    netPayGhs: 4697.36,
    status: "PENDING",
  });

  // 12c-stat. Statutory configuration — one live row (id=1) with the Ghana
  // defaults; editable later by the OWNER / authorized managers in Payroll
  // Center → Statutory Settings when regulations change.
  await db
    .insert(payrollStatutoryConfig)
    .values({
      id: 1,
      ssnitEmployeePct: 5.5,
      ssnitEmployerPct: 13,
      tier2Pct: 5,
      tier2Bearer: "EMPLOYER",
      payeBands: [
        { upto: 490, ratePct: 0 },
        { upto: 600, ratePct: 5 },
        { upto: 730, ratePct: 10 },
        { upto: 3896.67, ratePct: 17.5 },
        { upto: 19896.67, ratePct: 25 },
        { upto: 69896.67, ratePct: 30 },
        { upto: null, ratePct: 35 },
      ] as any,
      customItems: [] as any,
      note: "Ghana statutory defaults (2026)",
      updatedByUserId: 1,
      updatedByName: "Kwame Mina",
      updatedByRole: "OWNER",
    })
    .onConflictDoNothing();

  // 12c-logo. Company settings — one live row (id=1) holding the GoMina
  // company logo (group fallback for every generated document). Uploaded
  // later by the OWNER in Manage Businesses → Logos.
  await db
    .insert(companySettings)
    .values({ id: 1, companyLogo: null })
    .onConflictDoNothing();

  // 12d. Supervisor & Auditor baseline — one auditor grant (Comfort Agbenyega,
  // Aqua worker → may audit the Poultry books: finance, payroll & attendance),
  // one verification + one open flag from the OWNER, and the matching trail
  // rows. Reviews attach to the EXISTING transactions — nothing duplicated.
  await db.insert(auditAssignments).values({
    userId: 13, // Comfort Agbenyega (WORKER, Aquaculture)
    userName: "Comfort Agbenyega",
    userRole: "WORKER",
    businessId: 1,
    branchCode: null, // all poultry branches
    modules: ["FINANCE", "PAYROLL", "ATTENDANCE"],
    note: "Poultry books & payroll QA review",
    grantedByUserId: 1,
    grantedByName: "Kwame Mina",
    grantedByRole: "OWNER",
  });
  await db.insert(auditReviews).values([
    {
      recordType: "TRANSACTION", recordSource: "transactions", recordId: 1,
      recordRef: "TRX-2026-1001", recordTitle: "INCOME · Egg Wholesale Supply — GH₵ 16,500.00",
      module: "FINANCE", businessId: 1, branchCode: "POULTRY-01", workerName: "Emmanuel Osei",
      action: "VERIFIED", status: "VERIFIED",
      reason: "Quarter-start spot check — matched the MoMo statement",
      reviewerUserId: 1, reviewerName: "Kwame Mina", reviewerRole: "OWNER",
      createdAt: new Date("2026-08-18T10:30:00.000Z"),
    },
    {
      recordType: "TRANSACTION", recordSource: "transactions", recordId: 4,
      recordRef: "TRX-2026-1004", recordTitle: "INCOME · Restaurant Daily Receipts — GH₵ 8,450.00",
      module: "FINANCE", businessId: 5, branchCode: "FOOD-01", workerName: "Chef Esi Mensah",
      action: "FLAGGED", status: "FLAGGED",
      issueTitle: "Weekend receipts — missing deposit slip",
      reason: "Weekend total looks 12% above trend with no matching deposit slip",
      comment: "Chef Esi — please attach the bank deposit slip for the weekend receipts.",
      assignedUserId: 7, assignedUserName: "Chef Esi Mensah", assignedUserRole: "BRANCH_MANAGER",
      reviewerUserId: 1, reviewerName: "Kwame Mina", reviewerRole: "OWNER",
      createdAt: new Date("2026-08-19T09:15:00.000Z"),
    },
  ]);
  await db.insert(auditTrail).values([
    {
      actorUserId: 1, actorName: "Kwame Mina", actorRole: "OWNER",
      action: "GRANT_ACCESS", targetType: "GRANT", targetLabel: "Comfort Agbenyega → Mina Akuafo Poultry Farm",
      businessId: 1, branchCode: null, detail: "Modules: FINANCE, PAYROLL, ATTENDANCE · Poultry books & payroll QA review",
      createdAt: new Date("2026-08-18T10:24:00.000Z"),
    },
    {
      actorUserId: 1, actorName: "Kwame Mina", actorRole: "OWNER",
      action: "VERIFY", targetType: "RECORD", targetLabel: "TRX-2026-1001",
      recordType: "TRANSACTION", recordId: 1, businessId: 1, branchCode: "POULTRY-01",
      reason: "Quarter-start spot check — matched the MoMo statement",
      createdAt: new Date("2026-08-18T10:30:00.000Z"),
    },
    {
      actorUserId: 1, actorName: "Kwame Mina", actorRole: "OWNER",
      action: "FLAG", targetType: "RECORD", targetLabel: "TRX-2026-1004",
      recordType: "TRANSACTION", recordId: 4, businessId: 5, branchCode: "FOOD-01",
      reason: "Weekend total looks 12% above trend with no matching deposit slip",
      detail: "Chef Esi — please attach the bank deposit slip for the weekend receipts.",
      createdAt: new Date("2026-08-19T09:15:00.000Z"),
    },
  ]);

  // 12e. Issue-workflow baseline — the seeded flag (#2) is routed to Chef Esi's
  // dashboard: per-issue conversation thread + an unread notification.
  await db.insert(auditIssueUpdates).values([
    {
      issueId: 2,
      actorUserId: 1, actorName: "Kwame Mina", actorRole: "OWNER",
      action: "FLAG", statusFrom: null, statusTo: "FLAGGED",
      note: "Weekend total looks 12% above trend with no matching deposit slip",
      evidence: "Attach the bank deposit slip for the weekend receipts.",
      createdAt: new Date("2026-08-19T09:15:00.000Z"),
    },
  ]);
  await db.insert(notifications).values([
    {
      userId: 7, // Chef Esi Mensah — branch manager, Mina Chop Bar
      type: "AUDIT_ISSUE_ASSIGNED",
      title: "Issue flagged: Weekend receipts — missing deposit slip",
      body: "Weekend total looks 12% above trend with no matching deposit slip. Chef Esi — please attach the bank deposit slip for the weekend receipts.",
      issueId: 2, recordType: "TRANSACTION", recordId: 4, recordRef: "TRX-2026-1004",
      businessId: 5, branchCode: "FOOD-01", actorName: "Kwame Mina",
      isRead: false,
      createdAt: new Date("2026-08-19T09:15:00.000Z"),
    },
  ]);

  // 12f. Daily checklist baseline — a small poultry task list assigned to the
  // poultry workers, with two days of dated completions, so Supervisors &
  // Auditors can review daily checklists and worker activities out of the box.
  const chkTemplates = await db.insert(checklistTemplates).values([
    { businessId: 1, branchCode: "POULTRY-01", taskKey: "FEED_STOCK_CHECK", taskLabel: "Check feed silo levels & log bag count", category: "OPERATIONS", sortOrder: 1, isActive: true, assignedToUserId: 11, assignedToName: "Kwabena Mensah", assignedToRole: "WORKER", createdByName: "Kwame Mina", createdByRole: "OWNER" },
    { businessId: 1, branchCode: "POULTRY-01", taskKey: "WATER_LINES_FLUSH", taskLabel: "Flush & refill drinker lines", category: "OPERATIONS", sortOrder: 2, isActive: true, assignedToUserId: 11, assignedToName: "Kwabena Mensah", assignedToRole: "WORKER", createdByName: "Kwame Mina", createdByRole: "OWNER" },
    { businessId: 1, branchCode: "POULTRY-01", taskKey: "EGG_COLLECTION_LOG", taskLabel: "Morning egg collection & crate tally", category: "PRODUCTION", sortOrder: 3, isActive: true, assignedToUserId: 10, assignedToName: "Akua Donkor", assignedToRole: "WORKER", createdByName: "Kwame Mina", createdByRole: "OWNER" },
    { businessId: 1, branchCode: "POULTRY-01", taskKey: "MORTALITY_SWEEP", taskLabel: "Mortality sweep & health observation notes", category: "HEALTH", sortOrder: 4, isActive: true, assignedToUserId: 10, assignedToName: "Akua Donkor", assignedToRole: "WORKER", createdByName: "Kwame Mina", createdByRole: "OWNER" },
    { businessId: 1, branchCode: "POULTRY-01", taskKey: "BIOSECURITY_FOOTBATH", taskLabel: "Refresh footbaths & gate biosecurity check", category: "HEALTH", sortOrder: 5, isActive: true, assignedToUserId: 11, assignedToName: "Kwabena Mensah", assignedToRole: "WORKER", createdByName: "Kwame Mina", createdByRole: "OWNER" },
  ]).returning();
  const tByKey = new Map(chkTemplates.map((t: any) => [t.taskKey, t]));
  const chkEntry = (key: string, date: string, done: boolean, extra: any = {}) => {
    const t: any = tByKey.get(key);
    return {
      businessId: 1, branchCode: "POULTRY-01", checklistDate: date,
      templateId: t.id, taskKey: t.taskKey, taskLabel: t.taskLabel, category: t.category,
      assignedToUserId: t.assignedToUserId, assignedToName: t.assignedToName, assignedToRole: t.assignedToRole,
      isCompleted: done,
      completedByName: done ? t.assignedToName : null,
      completedByRole: done ? t.assignedToRole : null,
      completedAt: done ? new Date(`${date}T08:40:00.000Z`) : null,
      notes: extra.notes || null,
      createdAt: new Date(`${date}T06:00:00.000Z`),
    };
  };
  await db.insert(checklistEntries).values([
    chkEntry("FEED_STOCK_CHECK", "2026-08-21", true, { notes: "38 bags layer mash in silo B" }),
    chkEntry("WATER_LINES_FLUSH", "2026-08-21", true),
    chkEntry("EGG_COLLECTION_LOG", "2026-08-21", true, { notes: "212 crates collected" }),
    chkEntry("MORTALITY_SWEEP", "2026-08-21", true, { notes: "3 mortalities — pen 4" }),
    chkEntry("BIOSECURITY_FOOTBATH", "2026-08-21", true),
    chkEntry("FEED_STOCK_CHECK", "2026-08-22", true, { notes: "31 bags — reorder due Friday" }),
    chkEntry("WATER_LINES_FLUSH", "2026-08-22", true),
    chkEntry("EGG_COLLECTION_LOG", "2026-08-22", true, { notes: "196 crates collected" }),
    chkEntry("MORTALITY_SWEEP", "2026-08-22", false),
    chkEntry("BIOSECURITY_FOOTBATH", "2026-08-22", false),
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // Standardized Ghana location normalization (Region → District/MMDA → Town)
  // Applied to every module so location data is consistent and reportable.
  // ─────────────────────────────────────────────────────────────────────────
  const branchLocations: Record<string, [string, string, string]> = {
    "POULTRY-01": ["Eastern", "Nsawam Adoagyiri Municipal", "Nsawam"],
    "BLOCK-01": ["Greater Accra", "Tema Metropolitan", "Spintex"],
    "AQUA-01": ["Eastern", "Asuogyaman", "Akosombo"],
    "LIVESTOCK-01": ["Greater Accra", "Ashaiman Municipal", "Ashaiman"],
    "FOOD-01": ["Greater Accra", "Korle Klottey Municipal", "Osu"],
    "TECH-01": ["Greater Accra", "Okaikwei North Municipal", "Kwame Nkrumah Circle"],
    "WASH-01": ["Greater Accra", "Ayawaso West Municipal", "Dzorwulu"],
  };

  for (const [code, [region, district, town]] of Object.entries(branchLocations)) {
    await db.execute(sql`
      UPDATE businesses SET region = ${region}, district = ${district}, town = ${town}
      WHERE code = ${code}
    `);
  }

  // Users, employees and assets inherit the standardized location of their branch
  await db.execute(sql`
    UPDATE users u SET region = b.region, district = b.district, town = b.town
    FROM businesses b WHERE u.assigned_business_id = b.id
  `);
  await db.execute(sql`
    UPDATE users SET region = 'Greater Accra', district = 'Accra Metropolitan', town = 'Accra'
    WHERE assigned_business_id IS NULL
  `);
  await db.execute(sql`
    UPDATE employees e SET region = b.region, district = b.district, town = b.town
    FROM businesses b WHERE e.business_id = b.id
  `);
  await db.execute(sql`
    UPDATE assets a SET region = b.region, district = b.district, town = b.town
    FROM businesses b WHERE a.business_id = b.id
  `);

  // Customers & suppliers standardized locations
  const customerLocs: [string, string, string, string][] = [
    ["Shoprite & Melcom Ghana Stores", "Greater Accra", "Accra Metropolitan", "Accra Central"],
    ["Consolidated Real Estate & Build Co", "Greater Accra", "Tema Metropolitan", "Spintex"],
    ["Labadi Beach Hotel & Resorts", "Greater Accra", "La Dade Kotopon Municipal", "La"],
    ["Nana Kwame Appiah", "Greater Accra", "Ayawaso West Municipal", "East Legon"],
  ];
  for (const [name, region, district, town] of customerLocs) {
    await db.execute(sql`
      UPDATE customers SET region = ${region}, district = ${district}, town = ${town}
      WHERE name = ${name}
    `);
  }

  const supplierLocs: [string, string, string, string][] = [
    ["Ghafeed Poultry Mills Ltd", "Ashanti", "Kumasi Metropolitan", "Kumasi"],
    ["Ghacem Cement Distributors Ltd", "Greater Accra", "Tema Metropolitan", "Tema"],
    ["Akosombo Fingerlings & Aquaculture Supplies", "Eastern", "Asuogyaman", "Akosombo"],
    ["Felicity & LG Solar Global Importers", "Greater Accra", "Okaikwei North Municipal", "Circle"],
  ];
  for (const [name, region, district, town] of supplierLocs) {
    await db.execute(sql`
      UPDATE suppliers SET region = ${region}, district = ${district}, town = ${town}
      WHERE name = ${name}
    `);
  }

  await ensureHardwareFlagship();
  await ensureWashFlagshipCatalogue();

  console.log("GoMina 360 Command Center database seeding completed successfully!");
}
