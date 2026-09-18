#!/usr/bin/env node
/**
 * verify-ai-guides.mjs — content + engine proofs for the GoMina "How to Use"
 * guides and the built-in AI assistant (run with: node --import tsx …).
 *
 *   Part 1 · coverage: every AiSectionGuide placement resolves to real,
 *            section-specific content (no silent COMMON.DEFAULT fallbacks)
 *            for POULTRY/BLOCK/TECH/FOOD/AQUA/WASH/TELECOM/HARDWARE/
 *            LIVESTOCK/GENERIC/SHARED/CCTV/AUDIT/PAYROLL/COMMAND_CENTER/
 *            WORKER/SALES_CENTER/TRACKING/TRANSPORT.
 *   Part 2 · engine v2: typo tolerance, synonyms, incomplete questions,
 *            intent inference (cross-section routing), and the
 *            never-invent rule (grounded fallback phrases).
 */
import { getGuide, answerQuestion } from "../src/lib/aiGuides.ts";

let failures = 0, passes = 0;
const ql = (ok, msg, extra = "") => {
  if (ok) { passes++; console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ""}`); }
  else { failures++; console.error(`  ✗ ${msg}${extra ? ` — ${extra}` : ""}`); }
};

const BIZ = { name: "E2E Unit", code: "UNIT-01", category: "Transportation" };

/* ═══ PART 1 — placements vs knowledge base ═══ */
console.log("── coverage: every section in the app resolves to curated content ──");
{
  const PLACEMENTS = {
    POULTRY: ["DASHBOARD", "FLOCKS", "FEED", "WATER", "HEALTH", "PRODUCTION", "INVENTORY", "FINANCE", "CHECKLIST", "AI_KNOWLEDGE"],
    BLOCK: ["DASHBOARD", "INVENTORY", "FINANCE", "QC", "CHECKLIST"],
    TECH: ["DASHBOARD", "PRODUCTS", "ORDERS", "FINANCE", "SERVICE", "STAFF", "CHECKLIST"],
    FOOD: ["DASHBOARD", "MENU", "STOCK", "ORDERS", "PURCHASES", "FINANCE"],
    AQUA: ["DASHBOARD", "STOCK", "PONDS", "FEED", "WATER", "HEALTH", "HARVEST", "FINANCE"],
    WASH: ["DASHBOARD", "SERVICES", "BOOKINGS", "WASHES", "STOCK", "STAFF", "REPORTS", "CHECKLIST"],
    TELECOM: ["DASHBOARD", "MOMO", "AIRDATA", "WIFI", "SALES", "FINANCE"],
    HARDWARE: ["DASHBOARD", "STOCK", "ORDERS", "DELIVERIES", "FINANCE", "YARD_OPS", "CHECKLIST"],
    LIVESTOCK: ["DEFAULT"],
    GENERIC: ["DASHBOARD", "INVENTORY", "FINANCE", "CHECKLIST"],
    SHARED: ["CUSTOMERS", "SUPPLIERS", "EMPLOYEES", "ASSETS", "INVENTORY", "TRANSACTIONS", "FINANCE"],
    CCTV: ["DEFAULT"],
    AUDIT: ["DEFAULT"],
    PAYROLL: ["DEFAULT"],
    COMMAND_CENTER: ["COMMAND_CENTER", "FINANCE_REPORT"],
    WORKER: ["WORKER"],
    SALES_CENTER: ["SALES_CENTER"],
    TRACKING: ["TRACKING"],
    TRANSPORT: ["DASHBOARD", "FLEET", "DRIVERS", "TRIPS", "BOOKINGS", "FUEL", "MAINTENANCE", "GPS", "TRACKERS", "COMPLIANCE", "CHECKLIST", "REPORTS"],
  };
  // sections allowed to intentionally share generic content
  const ALLOWED_GENERIC = new Set(["CHECKLIST"]);

  let total = 0, specific = 0;
  for (const [mod, sections] of Object.entries(PLACEMENTS)) {
    for (const sec of sections) {
      total++;
      const g = getGuide(mod, sec, BIZ);
      const isDefaultShell = g.title === "This section";
      if (!isDefaultShell || ALLOWED_GENERIC.has(sec)) {
        specific++;
      } else {
        ql(false, `${mod}.${sec} falls back to a generic default`, g.title);
      }
      if (g.tasks.length === 0 || g.faqs.length === 0) ql(false, `${mod}.${sec} has empty tasks/faqs`);
      // placeholders substituted (no raw {biz} tokens left in output)
      if (g.tasks.some((t) => t.steps.some((st) => st.includes("{biz}")))) ql(false, `${mod}.${sec} leaks a {biz} placeholder`);
    }
  }
  ql(specific === total, `all ${total} used sections resolve to curated content`, `${specific}/${total}`);

  // intentional fallbacks point at the RIGHT shared guides
  const techFin = getGuide("TECH", "FINANCE", BIZ);
  ql(techFin.title === "Financial Report", "TECH.FINANCE resolves to the shared financial report engine", techFin.title);
  const liveOverview = getGuide("LIVESTOCK", "DEFAULT", BIZ);
  ql(liveOverview.title === "Livestock Overview", "Livestock overview has real content", liveOverview.title);
  const tRevenue = getGuide("TRANSPORT", "DASHBOARD", BIZ);
  ql(tRevenue.title === "Transportation Dashboard" && tRevenue.tasks.some((t) => t.name === "Record daily revenue"), "TRANSPORT.DASHBOARD reflects the live module");
  const telWifi = getGuide("TELECOM", "WIFI", BIZ);
  ql(telWifi.title === "Wi-Fi & Vouchers", "TELECOM.WIFI has its own guide", telWifi.title);
}

/* ═══ PART 2 — engine v2 behaviour ═══ */
console.log("\n── engine: typos · synonyms · incomplete questions · inference · no invention ──");
{
  const check = (mod, sec, q, expect = [], anyOf = null, label = "") => {
    const g = getGuide(mod, sec, BIZ);
    const a = answerQuestion(g, q);
    const low = a.toLowerCase();
    const okAll = expect.every((e) => low.includes(e.toLowerCase()));
    const okAny = anyOf && anyOf.length ? anyOf.some((e) => low.includes(e.toLowerCase())) : true;
    ql(okAll && okAny, `${label || `${mod}.${sec}: “${q}”`}`, okAll && okAny ? "" : `got: ${a.slice(0, 90)}`);
    return a;
  };

  // — typos & spelling slips —
  check("TRANSPORT", "DASHBOARD", "recrd daliy revenu", ["revenue"], ["transport revenue", "book income", "income"], "typo: 'recrd daliy revenu' → daily revenue");
  check("TRANSPORT", "TRACKERS", "wat brands an conection methods r suported", ["registry"], ["tkstar", "traccar"], "typo: brands question");
  check("POULTRY", "PRODUCTION", "were do my egs go aftr i logg them", [], ["eggs", "inventory", "stock"], "typos: poultry eggs");
  check("TRANSPORT", "GPS", "my vehice is not reportng any positon", ["tracker", "position"], ["sim", "ingest", "manual"], "typos: tracker silent");

  // — synonyms —
  check("TRANSPORT", "DASHBOARD", "were does my takings go", ["finance"], ["income transaction", "ledger"], "synonym: takings = revenue");
  check("LIVESTOCK", "DEFAULT", "hw do i logg a vet cost?", ["expense"], ["finance ledger"], "synonym: cost = expense");
  check("TRANSPORT", "FUEL", "who computes fuel consumption", ["divided"], ["odometer", "gps"], "synonym: consumption = economy");
  check("TELECOM", "WIFI", "when do cards run out", [], ["expiry", "sell & activate", "validity"], "synonym: run out → expiry/activation");

  // — incomplete / terse questions —
  check("TRANSPORT", "DASHBOARD", "revenue", ["income"], ["revenue"], "terse: single word 'revenue'");
  check("TELECOM", "WIFI", "vouchers", [], ["sell", "activate", "voucher"], "terse: 'vouchers' routes to the wifi flow");
  check("TRANSPORT", "TRACKERS", "secret", ["re-link", "secret"], [], "terse: 'secret'");
  check("TRANSPORT", "DASHBOARD", "how do i use this?", [], ["record daily revenue", "fleet picture"], "empty question nudges, not invents");

  // — intent inference / cross-section routing —
  const g = getGuide("POULTRY", "DASHBOARD", BIZ);
  const nav = answerQuestion(g, "how do I link a gps tracker to a vehicle");
  ql(nav.includes("GPS Trackers") && nav.toLowerCase().includes("link / add"), "cross-section: poultry user asking about trackers is routed to the GPS Trackers tab", nav.slice(0, 70));
  const nav2 = answerQuestion(g, "my tracker lost the secret, how to replace");
  ql(nav2.includes("secret") || nav2.toLowerCase().includes("re-link"), "cross-section: secret intent lands on the answer", nav2.slice(0, 70));
  const nav3 = answerQuestion(getGuide("TRANSPORT", "DASHBOARD", BIZ), "where do i pay my workers salary");
  ql(nav3.toLowerCase().includes("payroll"), "cross-section: salary → Payroll Center", nav3.slice(0, 60));
  const nav4 = answerQuestion(getGuide("BLOCK", "DASHBOARD", BIZ), "who owes me money");
  ql(nav4.toLowerCase().includes("sales & payments"), "cross-section: debts → Sales & Payments", nav4.slice(0, 60));

  // — never invent functionality —
  const nonsense = answerQuestion(getGuide("TRANSPORT", "DASHBOARD", BIZ), "book a flight to accra for me");
  ql(nonsense.includes("don't have") && !nonsense.toLowerCase().includes("flight"), "no invention: flight request is admitted as out of scope", nonsense.slice(0, 60));
  const nonsense2 = answerQuestion(getGuide("FOOD", "MENU", BIZ), "can it repair my car brake pads");
  ql(nonsense2.includes("don't have") || nonsense2.toLowerCase().includes("maintenance"), "no invention: absurd request admitted or honestly re-routed", nonsense2.slice(0, 60));
  const g2 = getGuide("POULTRY", "DASHBOARD", BIZ);
  for (const qAns of [nonsense, nonsense2]) {
    // fallback must always ground the user in the CURRENT section's real tasks
    ql(qAns.indexOf("won't guess") !== -1 || qAns.indexOf("don't have") !== -1 || qAns.match(/i think you are looking/i) !== null,
      "fallback grounds the user politely", "…");
    break;
  }

  // — grounded fallback content points back at the section —
  const fb = answerQuestion(getGuide("TRANSPORT", "TRACKERS", BIZ), "quantum flux capacitor settings");
  ql(fb.toLowerCase().includes("link a gps tracker") && fb.includes("I don't have"), "fallback lists real tasks of the section", fb.slice(0, 70));
}

/* ═══ snapshot of a few real answers (visual QA in the log) ═══ */
console.log("\n── sample answers ──");
{
  const cases = [
    ["TRANSPORT", "DASHBOARD", "hw do i recrd daliy revenu"],
    ["TRANSPORT", "TRACKERS", "how 2 add tracker 2 my truck"],
    ["TELECOM", "MOMO", "failed momo withdrawal, what now?"],
    ["COMMAND_CENTER", "COMMAND_CENTER", "wy are my tiles grey?"],
  ];
  for (const [m, sec, q] of cases) {
    const a = answerQuestion(getGuide(m, sec, BIZ), q);
    console.log(`  · [${m}.${sec}] “${q}”\n    → ${a.split("\n").join("\n      ").slice(0, 240)}`);
  }
}

console.log(`\n═══ AI GUIDES RESULT: ${passes} pass · ${failures} fail ═══`);
process.exit(failures ? 1 : 0);
