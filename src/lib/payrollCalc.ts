// Statutory payroll calculation — Ghana 2026 (all rates editable by the
// OWNER / owner-authorized managers in the Payroll Center "Statutory
// Settings" tab; this module only holds the DEFAULTS used when no config
// row exists yet). Pure functions, shared by the API and the test suite.

export type PayeBand = { upto: number | null; ratePct: number }; // upto = cumulative monthly ceiling (null = top slice)
export type CustomItem = { name: string; pct: number; bearer: "EMPLOYEE" | "EMPLOYER"; base: "BASIC" | "GROSS"; active?: boolean };
export type StatutoryConfig = {
  ssnitEmployeePct: number; // % of basic — employee deduction
  ssnitEmployerPct: number; // % of basic — employer contribution
  tier2Pct: number; // % of basic — Tier-2 occupational pension
  tier2Bearer: "EMPLOYER" | "EMPLOYEE";
  payeBands: PayeBand[];
  customItems: CustomItem[];
};

// Ghana defaults: SSNIT Tier-1 5.5% EE / 13% ER on basic; Tier-2 5%
// (employer-borne by default); PAYE monthly bands; taxable = gross −
// employee SSNIT (SSNIT is tax-deductible).
export const DEFAULT_PAYE_BANDS: PayeBand[] = [
  { upto: 490, ratePct: 0 },
  { upto: 600, ratePct: 5 },
  { upto: 730, ratePct: 10 },
  { upto: 3896.67, ratePct: 17.5 },
  { upto: 19896.67, ratePct: 25 },
  { upto: 69896.67, ratePct: 30 },
  { upto: null, ratePct: 35 },
];

export const DEFAULT_STATUTORY: StatutoryConfig = {
  ssnitEmployeePct: 5.5,
  ssnitEmployerPct: 13,
  tier2Pct: 5,
  tier2Bearer: "EMPLOYER",
  payeBands: DEFAULT_PAYE_BANDS,
  customItems: [],
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Progressive PAYE on monthly taxable income over cumulative bands. */
export function payeFor(taxable: number, bands: PayeBand[]): number {
  let tax = 0;
  let floor = 0;
  for (const b of (bands || []).slice().filter((b) => b && b.ratePct >= 0)) {
    if (taxable <= floor) break;
    const cap = b.upto === null || b.upto === undefined ? Infinity : Number(b.upto);
    const slice = Math.min(taxable, cap) - floor;
    if (slice > 0) tax += (slice * Number(b.ratePct)) / 100;
    floor = cap;
  }
  return round2(tax);
}

export type StatutoryBreakdown = {
  gross: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  tier2: number;
  tier2Bearer: "EMPLOYER" | "EMPLOYEE";
  taxableIncome: number;
  paye: number;
  custom: { name: string; amount: number; bearer: "EMPLOYEE" | "EMPLOYER" }[];
  totalEmployeeDeductions: number; // SSNIT EE + PAYE + manual + employee-borne items
  employerContributions: number; // SSNIT ER + employer-borne items
  employerCost: number; // gross + employer contributions
  net: number;
};

/** Full gross → deductions → net pipeline for one entry. */
export function computeStatutory(
  input: { basic: number; allowances: number; overtimePay: number; manualDeductions: number; applyStatutory?: boolean | null },
  cfg: StatutoryConfig
): StatutoryBreakdown {
  const basic = Number(input.basic) || 0;
  const gross = round2(basic + (Number(input.allowances) || 0) + (Number(input.overtimePay) || 0));
  const manual = round2(Number(input.manualDeductions) || 0);
  if (input.applyStatutory === false) {
    // Statutory switched off for this entry (authorized manual decision):
    // only manual deductions come off the gross.
    const total = manual;
    return {
      gross, ssnitEmployee: 0, ssnitEmployer: 0, tier2: 0, tier2Bearer: cfg.tier2Bearer,
      taxableIncome: gross, paye: 0, custom: [], totalEmployeeDeductions: total,
      employerContributions: 0, employerCost: gross, net: round2(gross - total),
    };
  }
  // SSNIT & Tier-2 are charged on the basic salary.
  const ssnitEmployee = round2((basic * cfg.ssnitEmployeePct) / 100);
  const ssnitEmployer = round2((basic * cfg.ssnitEmployerPct) / 100);
  const tier2 = round2((basic * cfg.tier2Pct) / 100);

  const custom = ((cfg.customItems || []) as CustomItem[])
    .filter((c) => c && c.name && c.pct > 0 && c.active !== false)
    .map((c) => ({
      name: String(c.name),
      bearer: (c.bearer === "EMPLOYEE" ? "EMPLOYEE" : "EMPLOYER") as "EMPLOYEE" | "EMPLOYER",
      amount: round2((((c.base === "GROSS" ? gross : basic) as number) * Number(c.pct)) / 100),
    }));
  const customEmployee = round2(custom.filter((c) => c.bearer === "EMPLOYEE").reduce((s, c) => s + c.amount, 0));
  const customEmployer = round2(custom.filter((c) => c.bearer === "EMPLOYER").reduce((s, c) => s + c.amount, 0));

  const tier2Employee = cfg.tier2Bearer === "EMPLOYEE" ? tier2 : 0;
  const taxableIncome = round2(Math.max(0, gross - ssnitEmployee - tier2Employee - customEmployee));
  const paye = payeFor(taxableIncome, cfg.payeBands);

  const totalEmployeeDeductions = round2(ssnitEmployee + paye + manual + tier2Employee + customEmployee);
  const employerContributions = round2(ssnitEmployer + (cfg.tier2Bearer === "EMPLOYER" ? tier2 : 0) + customEmployer);

  return {
    gross,
    ssnitEmployee,
    ssnitEmployer,
    tier2,
    tier2Bearer: cfg.tier2Bearer,
    taxableIncome,
    paye,
    custom,
    totalEmployeeDeductions,
    employerContributions,
    employerCost: round2(gross + employerContributions),
    net: round2(gross - totalEmployeeDeductions),
  };
}

/** Map a payroll_statutory_config DB row (or null) to a StatutoryConfig. */
export function cfgFromRow(row: any | null | undefined): StatutoryConfig {
  if (!row) return DEFAULT_STATUTORY;
  return {
    ssnitEmployeePct: Number(row.ssnitEmployeePct ?? DEFAULT_STATUTORY.ssnitEmployeePct),
    ssnitEmployerPct: Number(row.ssnitEmployerPct ?? DEFAULT_STATUTORY.ssnitEmployerPct),
    tier2Pct: Number(row.tier2Pct ?? DEFAULT_STATUTORY.tier2Pct),
    tier2Bearer: row.tier2Bearer === "EMPLOYEE" ? "EMPLOYEE" : "EMPLOYER",
    payeBands: Array.isArray(row.payeBands) && row.payeBands.length ? row.payeBands : DEFAULT_PAYE_BANDS,
    customItems: Array.isArray(row.customItems) ? row.customItems : [],
  };
}
