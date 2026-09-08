import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * My Profile — self-service profile data for the SIGNED-IN user.
 *
 * PUT { photo: string | null }
 *   Stores (or clears, with null) the user's profile photo. Photos travel as
 *   data URLs — the client downsizes/crops to a 256×256 JPEG before upload,
 *   the same pattern the business/branch crest uploads use — and the photo
 *   then follows the user everywhere their profile is shown (navbar Staff
 *   menu, Users & Access, Signed-In Staff console). A user can only ever
 *   change THEIR OWN photo: the session decides whose row is updated.
 */

const MAX_PHOTO_CHARS = 700_000; // ~500KB base64 — far above the ~60KB client target
const PHOTO_RE = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export async function PUT(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();

    const body = await request.json().catch(() => ({}));
    const photo = body.photo;

    if (photo !== null && photo !== undefined) {
      if (typeof photo !== "string" || !PHOTO_RE.test(photo)) {
        return NextResponse.json(
          { success: false, error: "Photo must be a JPEG, PNG or WebP image." },
          { status: 400 },
        );
      }
      if (photo.length > MAX_PHOTO_CHARS) {
        return NextResponse.json(
          { success: false, error: "Photo is too large — please use an image under ~500 KB." },
          { status: 413 },
        );
      }
    }

    const value = photo ?? null;
    await db.update(users).set({ avatarUrl: value }).where(eq(users.id, session.user.id));

    return NextResponse.json({
      success: true,
      photoUrl: value,
      message: value ? "Profile photo saved." : "Profile photo removed.",
    });
  } catch (e: any) {
    console.error("profile PUT error", e);
    return NextResponse.json({ success: false, error: e?.message || "Failed to save profile photo" }, { status: 500 });
  }
}
