import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { imageErrorStatus, validateOptionalImage } from "@/lib/mediaValidation";

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

// Accept ANY common image format (JPEG, PNG, WebP, GIF, BMP, AVIF, HEIC,
// SVG, TIFF, ICO, …) — no needless format allow-list. The shared validator
// enforces the data-URL shape plus the avatar stored-byte budget (300 KB,
// far above the ~24 KB the browser produces for a 320px crop; alpha avatars
// re-encode to PNG, which is why the budget has PNG headroom).

export async function PUT(request: NextRequest) {
  ttlInvalidate("init");
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();

    const body = await request.json().catch(() => ({}));
    const photo = body.photo;

    const photoCheck = validateOptionalImage(photo, "avatar", { label: "Photo" });
    if (!photoCheck.ok) {
      // The status now says WHICH failure it was: an oversized payload is 413,
      // anything else about the value is 400. Collapsing both into one code made
      // a client read "not an image" as "too big" (and vice versa).
      return NextResponse.json(
        { success: false, error: photoCheck.error },
        { status: imageErrorStatus(photoCheck) },
      );
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
