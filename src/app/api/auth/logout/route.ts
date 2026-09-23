import { NextResponse } from "next/server";
import { destroySession, readSessionToken, SESSION_COOKIE, bustSessionCache } from "@/lib/auth";

export async function POST(request: Request) {
  await destroySession(readSessionToken(request));
  bustSessionCache(); // this process resolves the freshly-ended session immediately
  const res = NextResponse.json({ success: true });
  res.headers.set("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=0`);
  return res;
}
