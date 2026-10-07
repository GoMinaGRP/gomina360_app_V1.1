import React from "react";
import GoMinaApp from "@/components/GoMinaApp";
import { loginRegistrationInviteEnabled } from "@/lib/supportInfo";

/**
 * `/` — the application shell (sign-in gate → command center).
 *
 * SERVER component by design. It exists for exactly one reason: the platform
 * owner's **login-page registration switch** must reach the sign-in screen
 * WITHOUT the login page fetching anything. So the boolean is resolved here and
 * handed to the client as a plain prop:
 *
 *   • `revalidate = 60` keeps `/` STATIC (prerendered). The database read below
 *     happens at build time and on background revalidation — never on a user's
 *     request, so sign-in latency is unchanged and no new API call is made from
 *     the browser.
 *   • `POST /api/support-info` calls `revalidatePath("/")` when the owner flips
 *     the switch, so a change is live on the very next visit; the 60 s window is
 *     only the safety net if that call is ever lost.
 *   • FAIL-CLOSED: the helper returns `false` on a missing row or any error, so
 *     a database hiccup can only hide a marketing line — never break sign-in.
 */
export const revalidate = 60;

export default async function HomePage() {
  const loginRegistrationInvite = await loginRegistrationInviteEnabled();
  return <GoMinaApp loginRegistrationInvite={loginRegistrationInvite} />;
}
