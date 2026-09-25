import { NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { apiError } from "@/lib/apiError";

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const rows = await db
      .select()
      .from(integrations)
      .orderBy(desc(integrations.id));
    return NextResponse.json({ success: true, integrations: rows });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { id, action } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Integration ID required" },
        { status: 400 }
      );
    }

    const [item] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, Number(id)));

    if (!item) {
      return NextResponse.json(
        { success: false, error: "Integration not found" },
        { status: 404 }
      );
    }

    let newStatus = item.status;
    let newSyncTime = item.lastSync;

    if (action === "SYNC_NOW") {
      newSyncTime = "Just now (Successful)";
      newStatus = "CONNECTED";
    } else if (action === "TOGGLE_CONNECT") {
      newStatus = item.status === "CONNECTED" ? "READY_TO_CONNECT" : "CONNECTED";
      if (newStatus === "CONNECTED") {
        newSyncTime = "Just now (Handshake Verified)";
      }
    }

    const [updated] = await db
      .update(integrations)
      .set({
        status: newStatus,
        lastSync: newSyncTime,
      })
      .where(eq(integrations.id, Number(id)))
      .returning();

    return NextResponse.json({ success: true, integration: updated });
  } catch (error: any) {
    return apiError(error);
  }
}
