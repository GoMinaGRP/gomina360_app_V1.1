import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { businesses, fulfillmentMethods, fulfillmentOptions, inventoryItems, organizations } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const ONE_HOUR = 60 * 60;
const ONE_DAY = 24 * 60 * 60;

function notFound() {
  return NextResponse.json({ success: false, error: "Photo not found." }, { status: 404 });
}

function cacheHeaders(src: string, contentType?: string): HeadersInit {
  const etag = `"menu-photo-${createHash("sha1").update(src).digest("base64url").slice(0, 16)}"`;
  return {
    ETag: etag,
    "Cache-Control": `public, max-age=${ONE_HOUR}, stale-while-revalidate=${ONE_DAY}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function parseDataImage(src: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(src);
  if (!match) return null;
  try {
    return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const itemId = Number(url.searchParams.get("item"));
    const index = Math.max(0, Number(url.searchParams.get("index") || "0"));
    if (!Number.isFinite(itemId) || itemId <= 0 || !Number.isInteger(index)) return notFound();

    const [item] = await db
      .select({
        id: inventoryItems.id,
        businessId: inventoryItems.businessId,
        quantity: inventoryItems.quantity,
        status: inventoryItems.status,
        photo: inventoryItems.photo,
        photos: inventoryItems.photos,
        photoThumb: inventoryItems.photoThumb,
        photosThumb: inventoryItems.photosThumb,
      })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId))
      .limit(1);
    if (!item) return notFound();

    const [biz] = await db
      .select({
        id: businesses.id,
        status: businesses.status,
        ownerId: businesses.ownerId,
        onlineOrderingEnabled: businesses.onlineOrderingEnabled,
        preOrderEnabled: businesses.preOrderEnabled,
      })
      .from(businesses)
      .where(eq(businesses.id, item.businessId))
      .limit(1);
    if (!biz) return notFound();
    if (!["ACTIVE", "EXPANDING"].includes((biz.status || "").toUpperCase())) return notFound();
    if (biz.onlineOrderingEnabled === false) return notFound();

    if (biz.ownerId != null) {
      const [org] = await db
        .select({ status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, Number(biz.ownerId)))
        .limit(1);
      if (org && (org.status || "").toUpperCase() !== "ACTIVE") return notFound();
    }

    const hasStock = (Number(item.quantity) || 0) > 0 && item.status !== "OUT_OF_STOCK";
    let hasPreorder = false;
    if (!hasStock && biz.preOrderEnabled === true) {
      const optionRows = await db
        .select({ methodId: fulfillmentOptions.methodId })
        .from(fulfillmentOptions)
        .where(and(eq(fulfillmentOptions.active, true), eq(fulfillmentOptions.businessId, biz.id), eq(fulfillmentOptions.inventoryId, item.id)))
        .limit(6);
      if (optionRows.length > 0) {
        const methodChecks = await Promise.all(
          optionRows.map((o) =>
            db
              .select({ id: fulfillmentMethods.id })
              .from(fulfillmentMethods)
              .where(and(eq(fulfillmentMethods.active, true), eq(fulfillmentMethods.id, o.methodId)))
              .limit(1),
          ),
        );
        hasPreorder = methodChecks.some((rows) => rows.length > 0);
      }
    }
    if (!hasStock && !hasPreorder) return notFound();

    // Full-resolution gallery (lightbox/detail) — the primary photo first, in
    // the same order the catalogue advertises, plus the parallel ≤400px display
    // thumbnails generated at upload time.
    const photos: string[] = [];
    const thumbs: string[] = [];
    const gallery = Array.isArray(item.photos)
      ? item.photos.filter((p: any) => typeof p === "string" && p.length > 0)
      : [];
    // Kept raw + positional: entry i belongs to photos[i]. Filtering empty
    // entries would shift thumbnails onto the wrong gallery images.
    const galleryThumbs = Array.isArray(item.photosThumb) ? item.photosThumb : [];
    const thumbAt = (gi: number) =>
      typeof galleryThumbs[gi] === "string" && galleryThumbs[gi].length > 0 ? galleryThumbs[gi] : "";
    if (typeof item.photo === "string" && item.photo.length > 0) {
      photos.push(item.photo);
      thumbs.push((typeof item.photoThumb === "string" && item.photoThumb) || thumbAt(0));
    }
    for (let gi = 0; gi < gallery.length; gi++) {
      const p = gallery[gi];
      const at = photos.indexOf(p);
      if (at >= 0) {
        if (!thumbs[at]) thumbs[at] = thumbAt(gi);
        continue;
      }
      photos.push(p);
      thumbs.push(thumbAt(gi));
    }
    // `size=thumb`: serve the display thumbnail (grids, gallery strip). Rows
    // uploaded before thumbnails existed fall back to the full image, so the
    // parameter is always safe to send.
    const wantThumb = (url.searchParams.get("size") || "").toLowerCase() === "thumb";
    const src = photos[index];
    if (!src) return notFound();
    const thumbSrc = wantThumb ? thumbs[index] : "";
    const served = thumbSrc || src;

    const ifNoneMatch = request.headers.get("if-none-match");
    const headers = cacheHeaders(served);
    if (ifNoneMatch && ifNoneMatch === (headers as Record<string, string>).ETag) {
      return new NextResponse(null, { status: 304, headers });
    }

    const dataImage = parseDataImage(served);
    if (dataImage) {
      const body = new Uint8Array(dataImage.bytes.buffer, dataImage.bytes.byteOffset, dataImage.bytes.byteLength);
      return new NextResponse(body as unknown as BodyInit, {
        status: 200,
        headers: cacheHeaders(served, dataImage.mime),
      });
    }

    // Keep the JSON catalogue small even when legacy/demo records hold remote
    // URLs.  The browser may load those lazily as images, but the API never
    // inlines them into the menu payload.
    if (/^https:\/\//i.test(served)) {
      const redirect = NextResponse.redirect(served, 302);
      for (const [key, value] of Object.entries(cacheHeaders(served))) redirect.headers.set(key, value);
      return redirect;
    }

    return notFound();
  } catch (e) {
    console.error("/api/menu/photo failed", e);
    return NextResponse.json({ success: false, error: "Unable to load photo." }, { status: 500 });
  }
}
