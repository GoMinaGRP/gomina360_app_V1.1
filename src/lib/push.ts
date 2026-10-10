/**
 * Web Push dispatch — phone/laptop notifications (Gmail-style) for the staff
 * app. A service worker (/sw.js) receives the push, shows the OS notification
 * even when nobody is inside the app, and clicking it opens the deep link
 * (/?tab=…) on the exact relevant page.
 *
 * Every dispatch is best-effort and never blocks business logic: failures
 * are logged and swallowed. Dead subscriptions (browser revoked them) are
 * pruned on 404/410 so the table stays clean.
 *
 * Category model (user-toggleable in the bell → Settings panel):
 *   orders    — online orders, order status changes, order assignments,
 *               purchases recorded/received
 *   approvals — audit flags, corrections required, resolutions & verifications
 *   alerts    — everything not otherwise categorised (default bucket)
 *   tasks     — checklist/task workflow types (TASK_* / CHECKLIST_*)
 *   messages  — audit issue responses & discussion (AUDIT_ISSUE_RESPONSE)
 *   reports   — report/export ready types (REPORT_* / EXPORT_*)
 */

import webpush from "web-push";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { pushConfig, pushSubscriptions, userPushSettings } from "@/db/schema";
import { bellCategoryFor, bellDestinationTab } from "@/lib/bellTypes";

export type PushCategory = "orders" | "approvals" | "alerts" | "tasks" | "messages" | "reports";
export const PUSH_CATEGORIES: PushCategory[] = ["orders", "approvals", "alerts", "tasks", "messages", "reports"];

/**
 * The push toggle a type belongs to is declared ONCE, in `bellTypes.ts` — the
 * same registry that decides the bell's label and where a tap lands. This local
 * map used to be a fourth parallel copy of the same knowledge and drifted from
 * all the others.
 */
export function categoryForType(type: string): PushCategory {
  return bellCategoryFor(type) as PushCategory;
}

/**
 * Where a tap on the notification should land inside the staff app.
 *
 * Delegates to the registry (`bellTypes.ts`). The previous implementation was a
 * long `if`-chain whose catch-all was `/?tab=TRACKING`, so 18 of the 42 types
 * the app emits — credit dunning, document expiry, checklist overdue, poultry
 * stage, every purchase, every feed-mill and block-factory batch, transport
 * alerts — opened Customer Order & Tracking, a page with nothing to do with
 * them. An unregistered type now falls back to the Command Center rather than
 * silently opening an unrelated console.
 */
export function urlForNotification(
  type: string,
  opts?: { branchCode?: string | null; issueId?: number | null; platformRequestRef?: string | null },
): string {
  return `/?tab=${bellDestinationTab(type, opts)}`;
}

let cachedVapid: { publicKey: string; privateKey: string } | null = null;

/** Load (or lazily generate once) the group-wide VAPID keypair. */
export async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (cachedVapid) return cachedVapid;
  const [row] = await db.select().from(pushConfig).where(eq(pushConfig.id, 1));
  if (row) {
    cachedVapid = { publicKey: row.vapidPublic, privateKey: row.vapidPrivate };
    return cachedVapid;
  }
  const keys = webpush.generateVAPIDKeys();
  await db.insert(pushConfig).values({ id: 1, vapidPublic: keys.publicKey, vapidPrivate: keys.privateKey });
  cachedVapid = keys;
  return keys;
}

export interface PushPayload {
  type: string;
  title: string;
  body?: string | null;
  url?: string;
}

/**
 * Send a push to every subscribed device of the given users, honouring each
 * user's notification settings (master switch + the type's category toggle).
 * `force` bypasses settings (used by the in-app "Send test notification").
 */
export async function pushToUsers(
  userIds: number[],
  payload: PushPayload,
  opts?: { force?: boolean },
): Promise<{ attempted: number; sent: number; pruned: number }> {
  const ids = Array.from(new Set((userIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
  if (!ids.length) return { attempted: 0, sent: 0, pruned: 0 };
  try {
    const vapid = await getVapidKeys();
    webpush.setVapidDetails("mailto:support@gomina360.com", vapid.publicKey, vapid.privateKey);

    let allowed = ids;
    if (!opts?.force) {
      const settings = await db
        .select()
        .from(userPushSettings)
        .where(inArray(userPushSettings.userId, ids));
      const byUser = new Map(settings.map((s) => [Number(s.userId), s]));
      const category = categoryForType(payload.type);
      allowed = ids.filter((id) => {
        const s: any = byUser.get(id);
        if (!s) return true; // no row yet ⇒ defaults (all on)
        if (s.enabled === false) return false;
        return s[category] !== false;
      });
    }
    if (!allowed.length) return { attempted: 0, sent: 0, pruned: 0 };

    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, allowed));
    if (!subs.length) return { attempted: 0, sent: 0, pruned: 0 };

    const body = JSON.stringify({
      title: payload.title,
      body: (payload.body || "").slice(0, 300),
      url: payload.url || "/",
      type: payload.type,
      category: categoryForType(payload.type),
      tag: `gomina-${categoryForType(payload.type)}`,
    });

    let sent = 0;
    let pruned = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 3600 },
          );
          sent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            // The browser dropped this subscription — prune it.
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).catch(() => {});
            pruned++;
          }
        }
      }),
    );
    return { attempted: subs.length, sent, pruned };
  } catch (e) {
    console.error("[push] dispatch failed:", e);
    return { attempted: 0, sent: 0, pruned: 0 };
  }
}

/** Fire-and-forget dispatch after bell rows landed (never await in routes). */
export function pushAfterBell(userIds: number[], payload: PushPayload): void {
  void pushToUsers(userIds, payload).catch(() => {});
}

/** Delete every subscription row of a dead endpoint (helper for routes). */
export async function removeSubscription(endpoint: string, userId: number) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
}
