import { NextResponse } from "next/server";
import { getSessionInfo, accessibleBusinessIds } from "@/lib/auth";

export async function GET(request: Request) {
  const info = await getSessionInfo(request);
  if (!info) {
    return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
  }
  const { passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe } = info.user;
  const access = await accessibleBusinessIds(info.user);
  return NextResponse.json({ success: true, user: safe, accessibleBusinessIds: access });
}
