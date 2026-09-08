import { NextResponse } from "next/server";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { getVapidKeys } from "@/lib/push";

/** The group-wide VAPID public key — the browser needs it to subscribe. */
export async function GET(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const keys = await getVapidKeys();
    return NextResponse.json({ success: true, publicKey: keys.publicKey });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
