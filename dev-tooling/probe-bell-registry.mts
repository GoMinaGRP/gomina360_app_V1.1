/** Prints UNREGISTERED:<n> and any MISROUTED rows for the registry audit. */
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { isRegisteredBellType, bellDestinationTab, FALLBACK_TAB } from "@/lib/bellTypes";
(async () => {
  const rows = await db.selectDistinct({ type: notifications.type }).from(notifications);
  const types = rows.map((r) => String(r.type || "")).filter(Boolean).sort();
  const bad = types.filter((t) => !isRegisteredBellType(t));
  console.log(`UNREGISTERED:${bad.length}${bad.length ? " " + bad.join(",") : ""}`);
  console.log(`TYPES:${types.length}`);
  const mis = types
    .map((t) => ({ t, tab: bellDestinationTab(t) }))
    .filter((x) => x.tab === "TRACKING" && !/ORDER|TRACKING|PREORDER|TRANSPORT/.test(x.t));
  console.log(`MISROUTED:${mis.length ? mis.map((m) => `${m.t}->${m.tab}`).join(",") : "none"}`);
  console.log(`FALLBACK:${FALLBACK_TAB}`);
  process.exit(0);
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
