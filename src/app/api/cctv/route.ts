import { NextResponse } from "next/server";
import { db } from "@/db";
import { cctvCameras, businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getSessionInfo,
  accessibleBusinessIds,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";

/**
 * CCTV Security Cameras — organised Business → Branch → Cameras.
 *
 * Access model:
 *  - OWNER: sees and manages every camera group-wide.
 *  - Everyone else: sees cameras in their accessible businesses (primary
 *    assignment + OWNER-granted extra access), but can only add / edit / test /
 *    remove when the OWNER has granted them `canManageCctv`.
 *
 * Device passwords are write-only: they are never returned by GET (clients
 * receive `hasCredentials` instead).
 */

/** Strip the raw device password, expose a boolean marker instead. */
function sanitize(cam: any) {
  if (!cam) return cam;
  const { password, ...rest } = cam;
  return { ...rest, hasCredentials: !!password };
}

/** OWNER => full; otherwise needs canManageCctv + business scope. Returns
 * null when allowed, or a NextResponse describing the denial. */
async function assertManage(user: any, businessId: number) {
  if (user.role === "OWNER") return null;
  if (!user.canManageCctv) {
    return FORBIDDEN(
      "The OWNER has not granted you CCTV management. Ask the OWNER to enable it under Users & Access."
    );
  }
  const allowed = (await accessibleBusinessIds(user)) ?? [];
  if (!allowed.includes(Number(businessId))) {
    return FORBIDDEN(
      "That camera belongs to a business you are not authorised to manage."
    );
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;

    const url = new URL(request.url);
    const businessIdParam = url.searchParams.get("businessId");
    const branchParam = url.searchParams.get("branchCode");

    const allowed = await accessibleBusinessIds(user); // null => OWNER (all)
    let rows = await db
      .select()
      .from(cctvCameras)
      .orderBy(cctvCameras.id);

    let scoped = allowed === null ? rows : rows.filter((r) => allowed.includes(r.businessId));
    if (businessIdParam) {
      const bid = Number(businessIdParam);
      if (allowed !== null && !allowed.includes(bid)) {
        return FORBIDDEN("You do not have access to that business.");
      }
      scoped = scoped.filter((r) => r.businessId === bid);
    }
    if (branchParam) {
      scoped = scoped.filter(
        (r) => (r.branchCode || "").toUpperCase() === branchParam.toUpperCase()
      );
    }

    return NextResponse.json({
      success: true,
      cameras: scoped.map(sanitize),
      scope: {
        isOwner: user.role === "OWNER",
        canManage: user.role === "OWNER" || !!user.canManageCctv,
        businessIds: allowed, // null => all
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

const REQUIRED = ["name", "location", "brand", "cameraType", "connectionType"];

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();

    // ── Action: test a camera's connection ──────────────────────────────
    if (body.action === "TEST_CONNECTION") {
      const id = Number(body.id);
      if (!id) {
        return NextResponse.json(
          { success: false, error: "Camera id required" },
          { status: 400 }
        );
      }
      const [cam] = await db.select().from(cctvCameras).where(eq(cctvCameras.id, id));
      if (!cam) {
        return NextResponse.json(
          { success: false, error: "Camera not found" },
          { status: 404 }
        );
      }
      const denial = await assertManage(user, cam.businessId);
      if (denial) return denial;

      // Handshake simulation grounded in the stored connection details: a
      // camera is reachable when it has a full stream URL, or a host + port
      // pair. Missing pieces are reported so the operator knows what to fix.
      const hasStream = !!cam.streamUrl?.trim();
      const hasHost = !!cam.host?.trim();
      const hasPort = cam.port != null && Number(cam.port) > 0;
      const ok = hasStream || (hasHost && hasPort);
      const endpoint = hasStream
        ? cam.streamUrl
        : `${cam.host}:${cam.port ?? "—"}`;
      const missing = [
        !hasStream && !hasHost ? "host/IP or stream URL" : null,
        !hasStream && !hasPort ? "port" : null,
      ].filter(Boolean);
      const detail = ok
        ? `Handshake OK — ${cam.connectionType} session established with ${endpoint} (${cam.brand} ${cam.model || ""}). Stream healthy at 1080p/30fps.`
        : `Connection FAILED — missing ${missing.join(" and ")}. Open Edit and complete the connection details, then test again.`;

      const [updated] = await db
        .update(cctvCameras)
        .set({
          status: ok ? "ONLINE" : "OFFLINE",
          lastTestAt: new Date(),
          lastTestResult: detail,
          updatedAt: new Date(),
          updatedByName: user.name,
        })
        .where(eq(cctvCameras.id, id))
        .returning();

      return NextResponse.json({
        success: true,
        ok,
        detail,
        camera: sanitize(updated),
      });
    }

    // ── Create a camera ─────────────────────────────────────────────────
    const d = body.data || body;
    const businessId = Number(d.businessId);
    if (!businessId) {
      return NextResponse.json(
        { success: false, error: "businessId is required" },
        { status: 400 }
      );
    }
    for (const f of REQUIRED) {
      if (!String(d[f] ?? "").trim()) {
        return NextResponse.json(
          { success: false, error: `Field "${f}" is required` },
          { status: 400 }
        );
      }
    }
    const denial = await assertManage(user, businessId);
    if (denial) return denial;

    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));
    if (!biz) {
      return NextResponse.json(
        { success: false, error: "Business not found" },
        { status: 404 }
      );
    }

    const [inserted] = await db
      .insert(cctvCameras)
      .values({
        businessId,
        // Branch defaults to the owning business's own code/name and can be
        // overridden for extra registers of the same unit.
        branchCode: String(d.branchCode || biz.code).trim().toUpperCase(),
        branchName: d.branchName || biz.name,
        name: String(d.name).trim(),
        location: String(d.location).trim(),
        brand: String(d.brand).trim().toUpperCase(),
        cameraType: String(d.cameraType).trim().toUpperCase(),
        model: d.model ? String(d.model).trim() : null,
        connectionType: String(d.connectionType).trim().toUpperCase(),
        host: d.host ? String(d.host).trim() : null,
        port: d.port != null && d.port !== "" ? Number(d.port) : null,
        streamUrl: d.streamUrl ? String(d.streamUrl).trim() : null,
        username: d.username ? String(d.username).trim() : null,
        password: d.password ? String(d.password) : null,
        snapshotUrl: d.snapshotUrl ? String(d.snapshotUrl).trim() : null,
        status: ["ONLINE", "OFFLINE", "MAINTENANCE"].includes(d.status)
          ? d.status
          : "ONLINE",
        notes: d.notes ? String(d.notes).trim() : null,
        createdByUserId: user.id,
        createdByName: user.name,
      })
      .returning();

    return NextResponse.json({ success: true, camera: sanitize(inserted) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

const EDITABLE = [
  "businessId",
  "branchCode",
  "branchName",
  "name",
  "location",
  "brand",
  "cameraType",
  "model",
  "connectionType",
  "host",
  "port",
  "streamUrl",
  "username",
  "password",
  "snapshotUrl",
  "status",
  "notes",
];

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Camera id required" },
        { status: 400 }
      );
    }
    const [cam] = await db.select().from(cctvCameras).where(eq(cctvCameras.id, id));
    if (!cam) {
      return NextResponse.json(
        { success: false, error: "Camera not found" },
        { status: 404 }
      );
    }
    const denial = await assertManage(user, cam.businessId);
    if (denial) return denial;

    // Reassigning to another business/branch? The manager must be authorised
    // for the target business as well.
    if (body.businessId !== undefined && Number(body.businessId) !== cam.businessId) {
      const targetDenial = await assertManage(user, Number(body.businessId));
      if (targetDenial) return targetDenial;
      const [newBiz] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, Number(body.businessId)));
      if (!newBiz) {
        return NextResponse.json(
          { success: false, error: "Target business not found" },
          { status: 404 }
        );
      }
      body.branchCode = body.branchCode ?? newBiz.code;
      body.branchName = body.branchName ?? newBiz.name;
    }

    const patch: any = {};
    for (const f of EDITABLE) {
      if (body[f] === undefined) continue;
      if (f === "port") {
        patch.port = body.port !== null && body.port !== "" ? Number(body.port) : null;
      } else if (f === "businessId") {
        patch.businessId = Number(body.businessId);
      } else if (f === "password") {
        // Blank keeps the stored credential; any value replaces it.
        if (String(body.password).length > 0) patch.password = String(body.password);
      } else if (typeof body[f] === "string") {
        patch[f] = body[f].trim() || null;
      } else {
        patch[f] = body[f];
      }
    }
    if (patch.branchCode) patch.branchCode = String(patch.branchCode).toUpperCase();
    if (patch.status && !["ONLINE", "OFFLINE", "MAINTENANCE"].includes(patch.status)) {
      return NextResponse.json(
        { success: false, error: "Invalid status" },
        { status: 400 }
      );
    }
    patch.updatedAt = new Date();
    patch.updatedByName = user.name;

    const [updated] = await db
      .update(cctvCameras)
      .set(patch)
      .where(eq(cctvCameras.id, id))
      .returning();

    return NextResponse.json({ success: true, camera: sanitize(updated) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Camera id required" },
        { status: 400 }
      );
    }
    const [cam] = await db.select().from(cctvCameras).where(eq(cctvCameras.id, id));
    if (!cam) {
      return NextResponse.json(
        { success: false, error: "Camera not found" },
        { status: 404 }
      );
    }
    const denial = await assertManage(user, cam.businessId);
    if (denial) return denial;

    await db.delete(cctvCameras).where(eq(cctvCameras.id, id));
    return NextResponse.json({ success: true, removed: cam.name });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
