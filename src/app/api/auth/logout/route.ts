import { NextResponse } from "next/server";
import { destroySession, readSessionToken, SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  await destroySession(readSessionToken(request));
  const res = NextResponse.json({ success: true });
  res.headers.set("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0`);
  return res;
}
