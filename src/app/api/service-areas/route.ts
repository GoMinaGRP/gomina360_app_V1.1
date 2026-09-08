import { NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, serviceAreas, pickupLocations } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

/**
 * Service areas / localities + pickup locations per Business (branch unit).
 *
 * AUTHORIZATION (both resources):
 *   • OWNER — full control over every unit group-wide.
 *   • Staff carrying the OWNER-granted canManageOnline permission (Users &
 *     Access → Permissions → “Online storefront & delivery areas”) — only on
 *     businesses/branches they can actually access (assignment ∪ grants).
 *   Everyone else: 403. Anonymous: 401.
 *
 * Customers never call this route: the public storefront reads the same data
 * through /api/menu (active rows only, never internal fields).
 *
 * GET    ?businessId=<id>         → { areas, pickups } scoped to that unit
 * POST   { businessId, …row }     → create one area / pickup (kind via ?kind=)
 * PATCH  { id, …patch }           → edit (?kind=) — same gate
 * DELETE { id }                   → remove (?kind=) — orders keep snapshots
 */

type Kind = "areas" | "pickups";

function kindFrom(request: Request): Kind {
  const k = new URL(request.url).searchParams.get("kind");
  return k === "pickups" ? "pickups" : "areas";
}

async function gate(request: Request, businessId: number) {
  const session = await getSessionInfo(request);
  if (!session) return { error: UNAUTHENTICATED() };
  const user = session.user as any;
  if (user.role === "OWNER") return { user };
  if (!user.canManageOnline) {
    return {
      error: FORBIDDEN(
        "Ask the OWNER to grant you “Online storefront & delivery areas” in Users & Access → Permissions.",
      ),
    };
  }
  if (!(await canAccessBusiness(user, businessId))) {
    return { error: FORBIDDEN("You do not have access to this business.") };
  }
  return { user };
}

function validLatLng(lat: any, lng: any): boolean {
  const la = Number(lat);
  const ln = Number(lng);
  return (
    Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180
  );
}

/** Both-or-neither GPS pair; returns [lat, lng] or [null, null] or throws 400. */
function gpsPair(body: any, latKey: string, lngKey: string): [number | null, number | null] {
  const lat = body[latKey];
  const lng = body[lngKey];
  const empty = (v: any) => v === null || v === undefined || v === "";
  if (empty(lat) && empty(lng)) return [null, null];
  if (!validLatLng(lat, lng)) {
    throw Object.assign(new Error("GPS coordinates look wrong — set a valid latitude/longitude pair using the map picker."), { status: 400 });
  }
  return [Number(lat), Number(lng)];
}

function checksumPhone(v: any): string | null {
  const s = typeof v === "string" ? v.trim().slice(0, 24) : "";
  return s || null;
}

/* ─────────────────────────────── GET (scoped list) ───────────────────── */
export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const businessId = Number(new URL(request.url).searchParams.get("businessId"));
    if (!Number.isFinite(businessId) || businessId <= 0) {
      return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
    }
    const g = await gate(request, businessId);
    if (g.error) return g.error;
    const [areas, pickups] = await Promise.all([
      db.select().from(serviceAreas).where(eq(serviceAreas.businessId, businessId)).orderBy(asc(serviceAreas.sortOrder), asc(serviceAreas.id)),
      db.select().from(pickupLocations).where(eq(pickupLocations.businessId, businessId)).orderBy(asc(pickupLocations.sortOrder), asc(pickupLocations.id)),
    ]);
    return NextResponse.json({ success: true, areas, pickups });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/* ─────────────────────────────── POST (create) ───────────────────────── */
export async function POST(request: Request) {
  try {
    const kind = kindFrom(request);
    const body = await request.json();
    const businessId = Number(body.businessId);
    if (!Number.isFinite(businessId) || businessId <= 0) {
      return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
    }
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });
    const g = await gate(request, businessId);
    if (g.error) return g.error;

    const name = String(body.name || "").trim().slice(0, 60);
    if (name.length < 2) {
      return NextResponse.json({ success: false, error: "Give it a clear name (2–60 characters)." }, { status: 400 });
    }
    const meta = {
      businessId,
      branchCode: biz.code,
      name,
      createdByUserId: g.user.id,
      createdByName: g.user.name,
      sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    };

    try {
      if (kind === "pickups") {
        const [lat, lng] = gpsPair(body, "lat", "lng");
        const [row] = await db
          .insert(pickupLocations)
          .values({
            ...meta,
            address: String(body.address || "").trim().slice(0, 200) || null,
            lat,
            lng,
            contactPhone: checksumPhone(body.contactPhone),
            instructions: String(body.instructions || "").trim().slice(0, 240) || null,
            active: body.active !== false,
          })
          .returning();
        return NextResponse.json({ success: true, pickup: row });
      }
      const [centerLat, centerLng] = gpsPair(body, "centerLat", "centerLng");
      let radiusKm: number | null = null;
      if (centerLat != null) {
        const r = Number(body.radiusKm ?? 5);
        if (!Number.isFinite(r) || r <= 0 || r > 1000) {
          return NextResponse.json(
            { success: false, error: "Area radius must be greater than 0 and at most 1000 km." },
            { status: 400 },
          );
        }
        radiusKm = Math.round(r * 100) / 100;
      }
      const [row] = await db
        .insert(serviceAreas)
        .values({
          ...meta,
          centerLat,
          centerLng,
          radiusKm,
          note: String(body.note || "").trim().slice(0, 160) || null,
          active: body.active !== false,
        })
        .returning();
      return NextResponse.json({ success: true, area: row });
    } catch (e: any) {
      if (e?.status === 400) return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      throw e;
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/* ─────────────────────────────── PATCH (edit) ────────────────────────── */
export async function PATCH(request: Request) {
  try {
    const kind = kindFrom(request);
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ success: false, error: "id is required." }, { status: 400 });
    }
    const table = kind === "pickups" ? pickupLocations : serviceAreas;
    const [existing]: any[] = await db.select().from(table).where(eq(table.id, id));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Not found — it may have been removed already." }, { status: 404 });
    }
    const g = await gate(request, existing.businessId);
    if (g.error) return g.error;

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      const name = String(body.name || "").trim().slice(0, 60);
      if (name.length < 2) {
        return NextResponse.json({ success: false, error: "Give it a clear name (2–60 characters)." }, { status: 400 });
      }
      updates.name = name;
    }
    if (body.active !== undefined) updates.active = !!body.active;
    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
      updates.sortOrder = Number(body.sortOrder);
    }
    try {
      if (kind === "pickups") {
        if (body.address !== undefined) updates.address = String(body.address || "").trim().slice(0, 200) || null;
        if (body.contactPhone !== undefined) updates.contactPhone = checksumPhone(body.contactPhone);
        if (body.instructions !== undefined) updates.instructions = String(body.instructions || "").trim().slice(0, 240) || null;
        if (body.lat !== undefined || body.lng !== undefined) {
          const [lat, lng] = gpsPair({ lat: body.lat ?? existing.lat, lng: body.lng ?? existing.lng }, "lat", "lng");
          // Explicit null pair clears the point.
          updates.lat = body.lat === null && body.lng === null ? null : lat;
          updates.lng = body.lat === null && body.lng === null ? null : lng;
        }
      } else {
        if (body.note !== undefined) updates.note = String(body.note || "").trim().slice(0, 160) || null;
        if (body.centerLat !== undefined || body.centerLng !== undefined) {
          const [lat, lng] = gpsPair(
            { centerLat: body.centerLat ?? existing.centerLat, centerLng: body.centerLng ?? existing.centerLng },
            "centerLat",
            "centerLng",
          );
          updates.centerLat = body.centerLat === null && body.centerLng === null ? null : lat;
          updates.centerLng = body.centerLat === null && body.centerLng === null ? null : lng;
          if (updates.centerLat == null) updates.radiusKm = null;
        }
        if (body.radiusKm !== undefined && (updates.centerLat !== null || existing.centerLat != null)) {
          if (body.radiusKm === null) {
            updates.radiusKm = null;
          } else {
            const r = Number(body.radiusKm);
            if (!Number.isFinite(r) || r <= 0 || r > 1000) {
              return NextResponse.json(
                { success: false, error: "Area radius must be greater than 0 and at most 1000 km." },
                { status: 400 },
              );
            }
            updates.radiusKm = Math.round(r * 100) / 100;
          }
        }
      }
    } catch (e: any) {
      if (e?.status === 400) return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      throw e;
    }

    const [row] = await db.update(table).set(updates).where(eq(table.id, id)).returning();
    return NextResponse.json({ success: true, [kind === "pickups" ? "pickup" : "area"]: row });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/* ─────────────────────────────── DELETE (remove) ─────────────────────── */
export async function DELETE(request: Request) {
  try {
    const kind = kindFrom(request);
    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ success: false, error: "id is required." }, { status: 400 });
    }
    const table = kind === "pickups" ? pickupLocations : serviceAreas;
    const [existing]: any[] = await db.select().from(table).where(eq(table.id, id));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Not found — it may have been removed already." }, { status: 404 });
    }
    const g = await gate(request, existing.businessId);
    if (g.error) return g.error;
    await db.delete(table).where(eq(table.id, id));
    // Orders keep their own snapshot of the chosen pickup point, so history
    // (Business → Branch → Orders → Delivery → Pickup) survives removal.
    return NextResponse.json({ success: true, removed: id });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
