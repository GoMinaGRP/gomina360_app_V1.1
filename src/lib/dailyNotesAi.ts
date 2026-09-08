/**
 * GoMina AI — Daily Notes analysis engine.
 *
 * An on-device (server-side) reasoning engine built for Ghanaian multi-business
 * operations. For every daily note a worker files, it:
 *   1. DETECTS ISSUES — matches the note against a curated operations
 *      taxonomy (health, water, feed, stock, machinery, staff, security,
 *      finance, sales, quality, hygiene, weather, delivery, customer) with
 *      per-keyword weights learned from the business' own vocabulary;
 *   2. SCORES SEVERITY — INFO (normal day), WATCH (something needs eyes),
 *      URGENT (critical events: deaths, breakdown, theft, fire, flood,
 *      injury, major loss) using critical-token escalation + weight totals;
 *   3. SPOTS TRENDS — compares today's flags against the business' rolling
 *      history: an issue seen 3+ times becomes a RECURRING TREND with counts;
 *   4. SUMMARISES — composes a concise one-look summary of the note and, over
 *      the rolling window, a narrative of how the unit is really doing;
 *   5. REMEMBERS — folds every analysed note into the business insights
 *      register (issue counts, first/last seen, category trends, capped day
 *      history), so the picture sharpens with each submission.
 *
 * Deterministic by design: the same note always yields the same analysis,
 * which keeps staffing decisions auditable and the E2E suite exact.
 */

export type IssueCategory =
  | "HEALTH" | "WATER" | "FEED" | "STOCK" | "MACHINE" | "STAFF" | "SECURITY"
  | "FINANCE" | "SALES" | "QUALITY" | "HYGIENE" | "WEATHER" | "DELIVERY" | "CUSTOMER";

export type Severity = "INFO" | "WATCH" | "URGENT";

export interface NoteIssue {
  category: IssueCategory;
  label: string;
  severity: Severity;
  matches: string[];
  recurring: boolean;
  historyCount: number;
}

export interface NoteAnalysis {
  summary: string;
  issues: NoteIssue[];
  severity: Severity;
  flags: string[];
}

export interface HistoryEntry {
  date: string;
  summary: string;
  severity: Severity;
  issues: { category: IssueCategory; label: string }[];
  noteCount: number;
}

export interface InsightsState {
  notesAnalyzed: number;
  lastNoteDate: string | null;
  rollingSummary: string | null;
  issueRegister: {
    category: IssueCategory;
    label: string;
    severity: Severity;
    count: number;
    firstDate: string;
    lastDate: string;
  }[];
  categoryTrends: Record<string, number>;
  history: HistoryEntry[];
}

export const EMPTY_INSIGHTS: InsightsState = {
  notesAnalyzed: 0,
  lastNoteDate: null,
  rollingSummary: null,
  issueRegister: [],
  categoryTrends: {},
  history: [],
};

/* ─── taxonomy ────────────────────────────────────────────────────── */

interface Lex {
  category: IssueCategory;
  label: string;
  /** ISSUE = something that needs attention; OPS = normal operations context. */
  kind: "ISSUE" | "OPS";
  critical?: boolean;
  words: string[];
}

const LEXICON: Lex[] = [
  { category: "HEALTH", label: "Animal / fish health event", kind: "ISSUE", words: ["sick", "illness", "disease", "mortality", "dead", "death", "died", "dies", "flu", "cough", "diarrhea", "diarrhoea", "weak bird", "weak", "limp", "swollen", "parasite", "worms", "mange", "injured", "injury", "bleeding"] },
  { category: "HEALTH", label: "Medication / vet response", kind: "OPS", words: ["vaccine", "vaccination", "vaccinated", "deworm", "dewormed", "vet", "antibiotic", "treatment", "treated", "medication", "injection"] },
  { category: "WATER", label: "Water supply problem", kind: "ISSUE", critical: true, words: ["no water", "water shortage", "water finished", "water stopped", "drinker leaking", "leaking drinker", "is leaking", "leaks", "leak", "dry drinker", "dry trough", "pump failed", "pump is down", "pump broken", "borehole", "pipe burst", "low oxygen", "oxygen low", "dirty water"] },
  { category: "WATER", label: "Water system maintenance", kind: "OPS", words: ["water", "drinker", "drinkers", "trough", "troughs", "pump", "aerator", "aerators"] },
  { category: "FEED", label: "Feed shortage or quality issue", kind: "ISSUE", critical: true, words: ["feed finished", "feed shortage", "no feed", "feed finished today", "out of feed", "feed running low", "running low on feed", "moldy feed", "mouldy feed", "spoilt feed", "bad feed"] },
  { category: "FEED", label: "Feeding operations", kind: "OPS", words: ["feed", "feeding", "fed", "concentrate", "maize", "bran", "pellets", "ration"] },
  { category: "STOCK", label: "Stock-out / shortage", kind: "ISSUE", critical: true, words: ["out of stock", "stock out", "sold out", "ran out", "running out", "shortage", "short of", "no cement", "no bags", "empty shelf", "depleted", "exhausted"] },
  { category: "STOCK", label: "Stock & restocking", kind: "OPS", words: ["restock", "restocked", "stock", "inventory", "supplies", "delivery of", "received stock", "low stock", "reorder"] },
  { category: "MACHINE", label: "Equipment breakdown", kind: "ISSUE", critical: true, words: ["breakdown", "broke down", "broken", "not working", "stopped working", "fault", "faulty", "failed", "failure", "generator off", "generator down", "machine down", "burst", "cracked", "snapped", "overheating", "jam", "jammed"] },
  { category: "MACHINE", label: "Equipment servicing", kind: "OPS", words: ["service", "serviced", "servicing", "repair", "repaired", "maintenance", "mechanic", "technician", "oil change", "spare part", "spare parts"] },
  { category: "STAFF", label: "Staffing gap", kind: "ISSUE", critical: true, words: ["absent", "did not come", "didn't come", "no show", "late", "late today", "short staffed", "short-staffed", "understaffed", "resigned", "quit"] },
  { category: "STAFF", label: "Staff performance / misconduct", kind: "ISSUE", words: ["argue", "argument", "fight", "fighting", "rude", "lazy", "misconduct", "warning issued", "verbal warning", "discipline"] },
  { category: "SECURITY", label: "Security incident", kind: "ISSUE", critical: true, words: ["theft", "stolen", "stealing", "robbery", "robbed", "thief", "break-in", "broke in", "intruder", "trespass", "gate left open", "padlock missing", "vandalism", "vandalized", "fire", "smoke", "burning", "flood", "flooded"] },
  { category: "SECURITY", label: "Biosecurity / gate control", kind: "OPS", words: ["biosecurity", "footbath", "disinfect", "disinfected", "visitor log", "gate check", "fence"] },
  { category: "FINANCE", label: "Money discrepancy", kind: "ISSUE", critical: true, words: ["short on cash", "cash short", "till short", "missing money", "unaccounted", "discrepancy", "not balancing", "does not balance", "overcharge", "undercharge"] },
  { category: "FINANCE", label: "Payments & credit issues", kind: "ISSUE", words: ["unpaid", "owing", "owes", "debt", "credit", "momo failed", "failed momo", "payment issue", "refund", "receipt missing", "no receipt"] },
  { category: "SALES", label: "Sales slowdown", kind: "ISSUE", words: ["slow sales", "no sales", "few customers", "quiet day", "sales dropped", "low turnout", "no buyers", "slow day"] },
  { category: "SALES", label: "Strong sales", kind: "OPS", words: ["busy", "rush", "sold out fast", "high demand", "good sales", "record sales", "many customers"] },
  { category: "QUALITY", label: "Quality defect", kind: "ISSUE", words: ["broken blocks", "cracked", "defective", "defect", "rejected", "rejection", "bad batch", "underweight", "small eggs", "dirty eggs", "soft shell", "returns", "spoiled", "expired"] },
  { category: "HYGIENE", label: "Hygiene / cleaning gap", kind: "ISSUE", words: ["dirty", "smell", "smelly", "not cleaned", "unclean", "litter", "manure pile", "flies", "maggot", "rats", "rodent", "pest"] },
  { category: "WEATHER", label: "Weather disruption", kind: "ISSUE", words: ["heavy rain", "raining", "rain stopped work", "storm", "flooding", "too hot", "heat", "harmattan", "dust", "cold"] },
  { category: "DELIVERY", label: "Delivery / dispatch issue", kind: "ISSUE", words: ["late delivery", "delivery late", "truck broke", "vehicle broke", "no vehicle", "driver late", "dispatch delayed", "wrong delivery", "missed delivery", "fuel finished"] },
  { category: "CUSTOMER", label: "Customer complaint / incident", kind: "ISSUE", words: ["complaint", "complained", "angry customer", "unhappy", "refund demanded", "bad review", "shouting", "dissatisfied"] },
];

const CRITICAL_HARD_WORDS = [
  "died", "death", "dead", "mortality", "theft", "stolen", "robbery", "fire",
  "flood", "break-in", "broke in", "injury", "injured", "hospital", "generator down",
];

const SEV_LABEL: Record<Severity, string> = {
  INFO: "Normal operations",
  WATCH: "Needs attention",
  URGENT: "Urgent — act today",
};

/* ─── helpers ─────────────────────────────────────────────────────── */

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ")} `;

function countOccurrences(hay: string, needle: string): number {
  let i = 0, n = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+|[;•]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

const sevRank = (s: Severity) => (s === "URGENT" ? 3 : s === "WATCH" ? 2 : 1);

/* ─── core analysis ───────────────────────────────────────────────── */

export function analyzeNote(content: string, history: HistoryEntry[]): NoteAnalysis {
  const text = norm(content);
  const counts = new Map<IssueCategory, { count: number; matches: string[]; critical: boolean }>();

  for (const lex of LEXICON) {
    if (lex.kind !== "ISSUE") continue; // routine operations never raise issues
    let n = 0;
    const matches: string[] = [];
    for (const w of lex.words) {
      const c = text.includes(w) ? Math.max(1, countOccurrences(text, w)) : 0;
      if (c > 0) { n += c; matches.push(w); }
    }
    if (n > 0) {
      const cur = counts.get(lex.category) || { count: 0, matches: [], critical: false };
      cur.count += n;
      cur.critical = cur.critical || (lex.critical ?? false);
      cur.matches.push(...matches);
      counts.set(lex.category, cur);
    }
  }

  // distinct labels per category (first lex hit's label wins the naming)
  const labelOf = (cat: IssueCategory) => {
    const lex = LEXICON.find((l) => l.category === cat && l.words.some((w) => text.includes(w)));
    return lex?.label || "Operations note";
  };

  // history recurrence: how many recorded days already carried this category
  const histCount = (cat: IssueCategory) =>
    history.filter((h) => (h.issues || []).some((i) => i.category === cat)).length;

  const hardCritical = CRITICAL_HARD_WORDS.some((w) => text.includes(w));

  const issues: NoteIssue[] = [];
  for (const [category, info] of counts) {
    const recurring = histCount(category) >= 2; // 3rd day on = a trend
    const sev: Severity =
      info.critical || (hardCritical && ["HEALTH", "SECURITY", "MACHINE", "WATER", "FEED", "FINANCE", "STAFF"].includes(category))
        ? "URGENT"
        : "WATCH";
    issues.push({
      category,
      label: labelOf(category),
      severity: sev,
      matches: Array.from(new Set(info.matches)).slice(0, 4),
      recurring,
      historyCount: histCount(category),
    });
  }
  issues.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.historyCount - a.historyCount);

  const severity: Severity = issues.length === 0 ? "INFO" : issues.some((i) => i.severity === "URGENT") ? "URGENT" : "WATCH";

  const flags = issues.map(
    (i) =>
      `${i.category.charAt(0) + i.category.slice(1).toLowerCase()}: ${i.label.toLowerCase()}${i.recurring ? ` — recurring (${i.historyCount + 1} days)` : ""}`,
  );

  // concise summary: lead with problems, mention the rest.
  const sentences = splitSentences(content);
  const problemCats = issues.filter((i) => i.severity !== "INFO");
  let summary: string;
  if (problemCats.length === 0) {
    summary = `Routine day logged — ${sentences[0] ? sentences[0].replace(/[.!\n]+$/, "").slice(0, 96) : "normal duties completed"}. No issues detected.`;
  } else {
    const top = problemCats
      .slice(0, 3)
      .map((i) => i.label.toLowerCase())
      .join("; ");
    const urgent = problemCats.filter((i) => i.severity === "URGENT").length;
    summary = `${urgent > 0 ? "Urgent day: " : ""}${problemCats.length} issue${problemCats.length === 1 ? "" : "s"} flagged — ${top}. ${sentences.length > 1 ? `${sentences[0].replace(/[.!\n]+$/, "").slice(0, 72)}.` : "See the full note."}`;
  }

  return { summary, issues, severity, flags };
}

/* ─── rolling insights ────────────────────────────────────────────── */

const HISTORY_CAP = 180;

/** Fold one analysed note into the rolling business-insights state. */
export function foldNoteIntoInsights(
  prev: InsightsState,
  note: { noteDate: string; analysis: NoteAnalysis },
): InsightsState {
  const state: InsightsState = {
    notesAnalyzed: (prev?.notesAnalyzed || 0) + 1,
    lastNoteDate: note.noteDate,
    rollingSummary: prev?.rollingSummary || null,
    issueRegister: Array.isArray(prev?.issueRegister) ? [...prev.issueRegister] : [],
    categoryTrends: { ...(prev?.categoryTrends || {}) },
    history: Array.isArray(prev?.history) ? [...prev.history] : [],
  };

  // merge into (or start) today's history entry
  const todayEntry = state.history.find((h) => h.date === note.noteDate);
  const issueRefs = note.analysis.issues.map((i) => ({ category: i.category, label: i.label }));
  if (todayEntry) {
    const merged = [...todayEntry.issues];
    for (const ir of issueRefs) if (!merged.some((m) => m.category === ir.category)) merged.push(ir);
    todayEntry.issues = merged;
    todayEntry.noteCount = (todayEntry.noteCount || 1) + 1;
    todayEntry.severity = sevRank(note.analysis.severity) > sevRank(todayEntry.severity) ? note.analysis.severity : todayEntry.severity;
    todayEntry.summary = note.analysis.summary; // freshest note summarises the day
  } else {
    state.history.unshift({
      date: note.noteDate,
      summary: note.analysis.summary,
      severity: note.analysis.severity,
      issues: issueRefs,
      noteCount: 1,
    });
  }
  state.history.sort((a, b) => (a.date < b.date ? 1 : -1));
  state.history = state.history.slice(0, HISTORY_CAP);

  // issue register + category trends
  for (const issue of note.analysis.issues) {
    const ex = state.issueRegister.find((r) => r.category === issue.category);
    if (ex) {
      ex.count += 1;
      ex.lastDate = note.noteDate;
      if (sevRank(issue.severity) > sevRank(ex.severity)) ex.severity = issue.severity;
      ex.label = issue.label;
    } else {
      state.issueRegister.push({
        category: issue.category,
        label: issue.label,
        severity: issue.severity,
        count: 1,
        firstDate: note.noteDate,
        lastDate: note.noteDate,
      });
    }
    state.categoryTrends[issue.category] = (state.categoryTrends[issue.category] || 0) + 1;
  }
  state.issueRegister.sort((a, b) => b.count - a.count || (a.lastDate < b.lastDate ? 1 : -1));

  state.rollingSummary = composeRollingSummary(state);
  return state;
}

/** Rebuild the whole insights state from scratch (used after a note is withdrawn). */
export function rebuildInsights(
  notes: { noteDate: string; analysis: NoteAnalysis }[],
): InsightsState {
  let state: InsightsState = JSON.parse(JSON.stringify(EMPTY_INSIGHTS));
  const ordered = [...notes].sort((a, b) => (a.noteDate > b.noteDate ? 1 : -1));
  for (const n of ordered) state = foldNoteIntoInsights(state, n);
  return state;
}

/** The AI narrative of "how this unit is really doing lately". */
export function composeRollingSummary(state: InsightsState): string {
  const window = state.history.slice(0, 14);
  if (window.length === 0) return "";
  const days = window.length;
  const urgentDays = window.filter((h) => h.severity === "URGENT").length;
  const watchDays = window.filter((h) => h.severity === "WATCH").length;
  const recurring = state.issueRegister.filter((r) => r.count >= 3).slice(0, 3);
  const parts: string[] = [];
  parts.push(
    `Across the last ${days} logged day${days === 1 ? "" : "s"} (${state.notesAnalyzed} note${state.notesAnalyzed === 1 ? "" : "s"} total):`,
  );
  if (urgentDays > 0) parts.push(`${urgentDays} URGENT day${urgentDays === 1 ? "" : "s"} — management must stay close;`);
  else if (watchDays > 0) parts.push(`${watchDays} day${watchDays === 1 ? "" : "s"} needed attention but nothing critical;`);
  else parts.push("operations have been smooth with no flagged issues;");
  if (recurring.length > 0) {
    parts.push(
      `recurring patterns: ${recurring.map((r) => `${r.label.toLowerCase()} (${r.count}×)`).join(", ")} — fix the root cause, not the symptom.`,
    );
  }
  return parts.join(" ");
}

/** Per-day AI summary merged from that day's notes (for the Daily Summary card). */
export function composeDaySummary(
  date: string,
  analyses: { analysis: NoteAnalysis }[],
): { summary: string; severity: Severity; flags: string[] } {
  let severity: Severity = "INFO";
  const flags: string[] = [];
  for (const a of analyses) {
    if (sevRank(a.analysis.severity) > sevRank(severity)) severity = a.analysis.severity;
    for (const f of a.analysis.flags) if (!flags.includes(f)) flags.push(f);
  }
  const flagged = analyses.filter((a) => a.analysis.issues.length > 0);
  const summary =
    analyses.length === 0
      ? ""
      : flagged.length === 0
        ? `Normal day (${analyses.length} note${analyses.length === 1 ? "" : "s"}): duties completed, no issues detected.`
        : `${SEV_LABEL[severity]} — ${flagged
            .slice(0, 2)
            .map((a) => a.analysis.summary.replace(/^Urgent day: /, "").replace(/\.$/, ""))
            .join("; ")}.`;
  return { summary, severity, flags: flags.slice(0, 8) };
}
