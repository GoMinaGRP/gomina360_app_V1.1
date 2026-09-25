// Farm Advisor per-section visibility — the ONE catalog shared by the Owner
// editors (Register form, Users & Access modal, Farm Advisors console), the
// server-side API stripping (/api/poultry, /api/aquaculture, /api/checklists,
// /api/init) and the read-only module UIs (tab filtering + panel gating).
//
// Model: every advisor grant (advisor_assignments row) carries a `sections`
// value for its farm unit —
//   null        → ALL sections of that unit (backward-compatible default for
//                 grants made before this feature existed)
//   string[]    → the exact section keys the Owner allowed; everything else is
//                 stripped server-side AND hidden in the UI
//
// Keys are module-prefixed-free inside a catalog: a grant's catalog is chosen
// by the unit's module (POULTRY / AQUA / LIVESTOCK), so keys stay short and
// the stored array is self-describing per unit.

export type SectionDef = { key: string; label: string; hint?: string };

export const POULTRY_SECTIONS: SectionDef[] = [
  { key: "DASHBOARD", label: "Dashboard", hint: "Overview cards & trends" },
  { key: "FLOCKS", label: "Flocks & Batches", hint: "Bird stock, ages, stages" },
  { key: "GROWTH", label: "Growth & Weights", hint: "Weight records, FCR, gain curves" },
  { key: "BENCHMARK", label: "Benchmark Performance", hint: "Actual vs targets, scorecards" },
  { key: "FEED", label: "Feed", hint: "Feed logs & consumption" },
  { key: "WATER", label: "Water", hint: "Water logs" },
  { key: "HEALTH", label: "Health & Vaccination", hint: "Health records, mortality" },
  { key: "PRODUCTION", label: "Production & Sales", hint: "Eggs, harvest, live-bird sales" },
  { key: "INVENTORY", label: "Inventory", hint: "Stock levels" },
  { key: "CHECKLIST", label: "Daily Checklist", hint: "Plan & completion status" },
  { key: "ALERTS", label: "Smart Alerts", hint: "AI alerts panel" },
  { key: "AI_KNOWLEDGE", label: "AI Knowledge", hint: "Poultry knowledge base" },
];

export const AQUA_SECTIONS: SectionDef[] = [
  { key: "DASHBOARD", label: "Dashboard", hint: "Overview cards & trends" },
  { key: "STOCK", label: "Fish Stock & Batches", hint: "Batches, counts, species" },
  { key: "PONDS", label: "Ponds / Tanks", hint: "Pond inventory" },
  { key: "GROWTH", label: "Growth & Weights", hint: "Sampling, biomass, FCR" },
  { key: "BENCHMARK", label: "Benchmark Performance", hint: "Actual vs targets, scorecards" },
  { key: "FEED", label: "Feed Management", hint: "Feed logs" },
  { key: "WATER", label: "Water Quality", hint: "DO, pH, ammonia readings" },
  { key: "HEALTH", label: "Tasks & Activities", hint: "Checklist tasks & status" },
  { key: "HARVEST", label: "Harvest Status", hint: "Harvest records" },
  { key: "ALERTS", label: "Smart Alerts", hint: "AI alerts panel" },
];

export const LIVESTOCK_SECTIONS: SectionDef[] = [
  { key: "OPERATIONS", label: "Livestock Operations", hint: "Overview, herd & grazing logs, checklist" },
];

export function sectionCatalog(moduleKey: string | null | undefined): SectionDef[] {
  switch (String(moduleKey || "").toUpperCase()) {
    case "POULTRY":
      return POULTRY_SECTIONS;
    case "AQUA":
      return AQUA_SECTIONS;
    case "LIVESTOCK":
      return LIVESTOCK_SECTIONS;
    default:
      return [];
  }
}

/** Normalize a raw stored/JSON value into null (= all) or a deduped key list
 *  validated against the unit's catalog. Unknown keys are dropped. */
export function normalizeSections(raw: any, moduleKey: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null; // all sections (legacy default)
  if (!Array.isArray(raw)) return null;
  const valid = new Set(sectionCatalog(moduleKey).map((s) => s.key));
  const keys = [...new Set(raw.map((k) => String(k)).filter((k) => valid.has(k)))];
  return keys.length ? keys : []; // [] = intentionally nothing
}

/** May the advisor view this section? (null sections = unrestricted) */
export function canViewSection(sections: string[] | null | undefined, key: string): boolean {
  if (sections === null || sections === undefined) return true;
  return sections.includes(key);
}

/** True when at least one section of the module's catalog is permitted. */
export function anySectionAllowed(sections: string[] | null | undefined, moduleKey: string | null | undefined): boolean {
  if (sections === null || sections === undefined) return sectionCatalog(moduleKey).length > 0;
  if (!Array.isArray(sections) || sections.length === 0) return false;
  const valid = new Set(sectionCatalog(moduleKey).map((s) => s.key));
  return sections.some((k) => valid.has(k));
}

/** Map a business (category / code) to its farm module key — mirrors the
 *  GoMinaApp MODULE_BY_CATEGORY + code-prefix logic; returns null for
 *  non-farm units (stores, factory, restaurant…). */
export function farmModuleOfBusiness(biz: { category?: string | null; code?: string | null } | null | undefined): string | null {
  if (!biz) return null;
  const BY_CATEGORY: Record<string, string> = {
    "Poultry Farm": "POULTRY",
    Aquaculture: "AQUA",
    Livestock: "LIVESTOCK",
  };
  const byCat = BY_CATEGORY[String(biz.category || "")];
  if (byCat) return byCat;
  const prefix = String(biz.code || "").split("-")[0]?.toUpperCase();
  if (prefix === "POULTRY") return "POULTRY";
  if (prefix === "AQUA") return "AQUA";
  if (prefix === "LIVESTOCK") return "LIVESTOCK";
  return null;
}
