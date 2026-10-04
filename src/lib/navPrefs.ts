/**
 * NAV PREFERENCES — per-user, per-browser navigation memory.
 *
 * Deliberately localStorage-only for v1 (decision #3 of the sidebar audit):
 * recents, favourites and collapsed sections are convenience state, not
 * business data — they must never touch the ledger, the tenant-scoped tables
 * or the backup/restore contract. A future cross-device version can mirror the
 * same shape into a user_preferences row without changing any caller.
 *
 * Everything is defensive: private-mode browsers, disabled storage and
 * corrupted JSON must all degrade to "no preferences" instead of throwing.
 */

export const NAV_PREFS_KEY = "gomina.nav.prefs.v1";
/** Fired on the window whenever preferences change (same-tab sync). */
export const NAV_PREFS_EVENT = "gomina:nav-prefs";

export interface NavPrefs {
  /** Section open/closed, keyed by NavGroupKey (true = open). */
  sections: Record<string, boolean>;
  /** Most-recent destination ids, newest first. */
  recents: string[];
  /** Starred destinations. */
  favTabs: string[];
  /** Starred business codes. */
  favUnits: string[];
  /** Icon-rail mode is a desktop preference (kept from the old sidebar). */
  collapsed: boolean;
}

const EMPTY: NavPrefs = { sections: {}, recents: [], favTabs: [], favUnits: [], collapsed: false };

const MAX_RECENTS = 6;
const MAX_FAV_TABS = 5;
const MAX_FAV_UNITS = 8;

export function loadNavPrefs(): NavPrefs {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const raw = window.localStorage.getItem(NAV_PREFS_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    return {
      sections: parsed && typeof parsed.sections === "object" && parsed.sections ? parsed.sections : {},
      recents: Array.isArray(parsed?.recents) ? parsed.recents.filter((x: any) => typeof x === "string") : [],
      favTabs: Array.isArray(parsed?.favTabs) ? parsed.favTabs.filter((x: any) => typeof x === "string") : [],
      favUnits: Array.isArray(parsed?.favUnits) ? parsed.favUnits.filter((x: any) => typeof x === "string") : [],
      collapsed: parsed?.collapsed === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveNavPrefs(patch: Partial<NavPrefs>): NavPrefs {
  const next = { ...loadNavPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(NAV_PREFS_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(NAV_PREFS_EVENT));
    } catch {
      /* storage unavailable — preferences simply do not persist */
    }
  }
  return next;
}

const uniq = (list: string[], max: number) =>
  Array.from(new Set(list.filter((x) => typeof x === "string" && x.length > 0))).slice(0, max);

/** Record a visit — called when the active destination changes. */
export function pushRecent(id: string): void {
  if (!id) return;
  const { recents } = loadNavPrefs();
  if (recents[0] === id) return;
  saveNavPrefs({ recents: uniq([id, ...recents.filter((r) => r !== id)], MAX_RECENTS) });
}

export function toggleFavTab(id: string): void {
  const { favTabs } = loadNavPrefs();
  saveNavPrefs({
    favTabs: favTabs.includes(id) ? favTabs.filter((x) => x !== id) : uniq([id, ...favTabs], MAX_FAV_TABS),
  });
}

export function toggleFavUnit(code: string): void {
  const { favUnits } = loadNavPrefs();
  saveNavPrefs({
    favUnits: favUnits.includes(code) ? favUnits.filter((x) => x !== code) : uniq([code, ...favUnits], MAX_FAV_UNITS),
  });
}

/**
 * Is this section open, for this user, right now?
 *
 * Precedence: the user's own stored choice → the group's `defaultCollapsed`
 * (low-frequency sections start closed; see the reassessment audit §4) → open.
 * A section that contains the destination currently on screen is force-opened
 * by the rail itself, so a default-collapsed section can never hide "you are
 * here" — that override deliberately does not touch this stored preference.
 */
export function isSectionOpen(prefs: NavPrefs, key: string, defaultCollapsed = false): boolean {
  const stored = prefs.sections[key];
  if (stored !== undefined) return stored !== false;
  return !defaultCollapsed;
}

/**
 * Quick-access strip: favourites first, then the most recent destinations —
 * de-duplicated, capped, and never including the destination already on screen.
 */
export function quickAccessIds(prefs: NavPrefs, exclude: string, max = 4): string[] {
  const out: string[] = [];
  for (const id of [...prefs.favTabs, ...prefs.recents]) {
    if (id !== exclude && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}
