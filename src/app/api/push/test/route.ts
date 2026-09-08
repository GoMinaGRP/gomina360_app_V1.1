import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { pushToUsers } from "@/lib/push";

/**
 * "Send test notification" — fires one push at the requesting user's own
 * devices through the full pipeline (VAPID → dispatch → prune). Force-sent
 * so it proves the plumbing even while a category toggle is being reviewed.
 */
export async function POST(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  const subCount = (
    await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, session.user.id))
  ).length;
  const result = await pushToUsers(
    [session.user.id],
    {
      type: "TEST_NOTIFICATION",
      title: "GoMina 360 — test notification",
      body: `It works, ${session.user.name?.split(" ")[0] || "there"}! Orders, approvals and alerts will land here — tap to open the app.`,
      url: "/?tab=COMMAND_CENTER",
    },
    { force: true },
  );
  return NextResponse.json({ success: true, subscriptions: subCount, ...result });
}
