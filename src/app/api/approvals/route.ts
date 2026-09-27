import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalPolicies, approvalRequests, businesses } from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { auditLog } from "@/lib/audit";
import {
  APPROVAL_ACTIONS,
  cancelApprovalRequest,
  decideApprovalRequest,
  pendingRequestsForApprover,
} from "@/lib/approvals";

/**
 * R1 Approvals API (CAPABILITY-AUDIT-REPORT §4).
 *
 *  GET  /api/approvals
 *    - myRequests   — everything I submitted (with its current state)
 *    - inbox        — PENDING requests I am entitled to decide
 *    - policies     — the organization's gate rules (OWNER/GM only)
 *    - businesses   — labels for the policy form's scope picker
 *    - actions      — the gateable action catalogue (for the form)
 *    - approvers    — who would be asked to decide (for the form preview)
 *
 *  POST /api/approvals  { op: … }
 *    - DECIDE         — approve/reject a pending request (approvers only)
 *    - CANCEL         — requester withdraws their still-pending request
 *    - POLICY_CREATE  — add a gate rule (OWNER; GM with org scope)
 *    - POLICY_UPDATE  — edit/deactivate a rule (OWNER; GM if they created it)
 *    - POLICY_DELETE  — remove a rule (OWNER only — audit-clean removal)
 *
 * Tenant isolation: every read is filtered to the caller's accessible
 * businesses; every policy write re-verifies the caller belongs to the
 * policy's organization; decisions re-resolve the live policy server-side.
 */

const POLICY_ROLES = ["OWNER", "GENERAL_MANAGER"];

function cleanAction(v: unknown): string | null {
  const a = String(v || "").toUpperCase();
  return (APPROVAL_ACTIONS as readonly string[]).includes(a) ? a : null;
}

function cleanThreshold(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user as any;
    const { searchParams } = new URL(request.url);
    const allowed = await accessibleBusinessIds(user); // number[] | null
    const role = String(user.role || "").toUpperCase();

    // ── My submitted requests (own rows, always visible to the requester) ──
    const mineWhere = [eq(approvalRequests.requestedByUserId, Number(user.id))];
    const bizFilter = Number(searchParams.get("businessId")) || 0;
    if (bizFilter) {
      if (allowed !== null && !allowed.includes(bizFilter)) return FORBIDDEN("That business is outside your scope.");
      mineWhere.push(eq(approvalRequests.businessId, bizFilter));
    }
    const myRequests = await db
      .select()
      .from(approvalRequests)
      .where(and(...mineWhere))
      .orderBy(desc(approvalRequests.id))
      .limit(200);

    // ── Approver inbox (managers/owners only; workers never decide) ──
    let inbox: any[] = [];
    if (role !== "WORKER") {
      inbox = await pendingRequestsForApprover(user, allowed);
    }

    // ── Business labels + policies for the manager view ──
    let policies: any[] = [];
    let businessLabels: { id: number; name: string; code: string }[] = [];
    if (POLICY_ROLES.includes(role) || user.isSuperAdmin) {
      const orgIds = new Set((user.organizationIds || []).map(Number));
      const polRows = await db
        .select()
        .from(approvalPolicies)
        .orderBy(desc(approvalPolicies.isActive), approvalPolicies.action, desc(approvalPolicies.id))
        .limit(200);
      policies = polRows.filter((p) => user.isSuperAdmin || orgIds.has(Number(p.ownerId)));
      const bizRows = await db
        .select({ id: businesses.id, name: businesses.name, code: businesses.code, ownerId: businesses.ownerId })
        .from(businesses)
        .orderBy(businesses.id)
        .limit(400);
      businessLabels = bizRows
        .filter((b) => allowed === null || allowed.includes(Number(b.id)))
        .map((b) => ({ id: Number(b.id), name: b.name, code: b.code }));
    }

    return NextResponse.json({
      success: true,
      myRequests,
      inbox,
      policies,
      businesses: businessLabels,
      actions: APPROVAL_ACTIONS,
    });
  } catch (error: any) {
    console.error("[api/approvals GET]", error);
    return NextResponse.json({ success: false, error: error?.message || "Failed to load approvals." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user as any;
    const body = await request.json().catch(() => ({}));
    const op = String(body?.op || "").toUpperCase();
    const role = String(user.role || "").toUpperCase();
    const myOrgs = new Set((user.organizationIds || []).map(Number));

    // ── DECIDE ─────────────────────────────────────────────────────────
    if (op === "DECIDE") {
      if (role === "WORKER") return FORBIDDEN("Workers cannot decide approvals.");
      const decision = String(body?.decision || "").toUpperCase();
      if (decision !== "APPROVE" && decision !== "REJECT") {
        return NextResponse.json({ success: false, error: "decision must be APPROVE or REJECT." }, { status: 400 });
      }
      const reason = body?.reason != null ? String(body.reason).slice(0, 500) : null;
      try {
        const result = await decideApprovalRequest({
          requestId: Number(body?.requestId),
          user,
          decision,
          reason,
        });
        return NextResponse.json({ success: true, request: result.request, effectNote: result.effectNote });
      } catch (e: any) {
        const msg = String(e?.message || "Decision failed.");
        const status = /not found/i.test(msg) ? 404 : /already/i.test(msg) ? 409 : /not an approver/i.test(msg) ? 403 : 400;
        return NextResponse.json({ success: false, error: msg }, { status });
      }
    }

    // ── CANCEL (requester withdraws) ───────────────────────────────────
    if (op === "CANCEL") {
      const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, Number(body?.requestId)));
      if (!req) return NextResponse.json({ success: false, error: "Request not found." }, { status: 404 });
      const isRequester = Number(req.requestedByUserId) === Number(user.id);
      const isOrgOwner = myOrgs.has(Number(req.ownerId)) && role === "OWNER";
      if (!isRequester && !isOrgOwner && !user.isSuperAdmin) {
        return FORBIDDEN("Only the requester (or the Owner) can withdraw a request.");
      }
      const row = await cancelApprovalRequest(Number(body?.requestId), { name: user.name });
      if (!row) return NextResponse.json({ success: false, error: "Request is no longer pending." }, { status: 409 });
      await auditLog(
        { id: user.id, name: user.name, role: user.role },
        "APPROVAL_CANCEL",
        "approval_requests",
        `${row.action} — ${row.targetLabel || row.targetType}#${row.targetId}`,
        "approval_requests",
        Number(row.id),
        Number(row.businessId),
        row.branchCode,
        "Withdrawn before decision",
        Number(row.ownerId),
      );
      return NextResponse.json({ success: true, request: row });
    }

    // ── POLICY CRUD (OWNER / GENERAL_MANAGER) ──────────────────────────
    if (!POLICY_ROLES.includes(role) && !user.isSuperAdmin) {
      return FORBIDDEN("Only the Owner or General Manager can manage approval policies.");
    }

    if (op === "POLICY_CREATE") {
      const action = cleanAction(body?.action);
      if (!action) {
        return NextResponse.json({ success: false, error: `action must be one of: ${(APPROVAL_ACTIONS as readonly string[]).join(", ")}` }, { status: 400 });
      }
      const scopeBusinessId = Number(body?.scopeBusinessId) || null;
      if (scopeBusinessId != null && !(await canAccessBusiness(user, scopeBusinessId))) {
        return FORBIDDEN("Cannot scope a policy to a business outside your access.");
      }
      const [biz] = scopeBusinessId != null
        ? await db.select({ ownerId: businesses.ownerId }).from(businesses).where(eq(businesses.id, scopeBusinessId))
        : [];
      const ownerId = scopeBusinessId != null ? Number(biz?.ownerId || 0) : Number([...myOrgs][0] || 0);
      if (!ownerId) return NextResponse.json({ success: false, error: "No organization scope resolved." }, { status: 400 });
      if (!user.isSuperAdmin && !myOrgs.has(ownerId)) {
        return FORBIDDEN("That business belongs to another organization.");
      }
      const approverRole = String(body?.approverRole || "OWNER").toUpperCase();
      if (!["OWNER", "GENERAL_MANAGER"].includes(approverRole)) {
        return NextResponse.json({ success: false, error: "approverRole must be OWNER or GENERAL_MANAGER." }, { status: 400 });
      }
      const approverUserId = Number(body?.approverUserId) || null;
      const thresholdAmountGhs = cleanThreshold(body?.thresholdAmountGhs);
      const thresholdPercent = cleanThreshold(body?.thresholdPercent);
      if (action === "DISCOUNT" && thresholdAmountGhs != null) {
        return NextResponse.json({ success: false, error: "DISCOUNT policies use thresholdPercent, not an amount." }, { status: 400 });
      }
      if (action !== "DISCOUNT" && thresholdPercent != null) {
        return NextResponse.json({ success: false, error: "thresholdPercent only applies to DISCOUNT policies." }, { status: 400 });
      }
      const [row] = await db
        .insert(approvalPolicies)
        .values({
          ownerId,
          action,
          scopeBusinessId,
          thresholdAmountGhs,
          thresholdPercent,
          approverRole,
          approverUserId,
          isActive: body?.isActive === false ? false : true,
          createdByName: user.name || "Staff",
        })
        .returning();
      await auditLog(
        { id: user.id, name: user.name, role: user.role },
        "APPROVAL_POLICY_CREATE",
        "approval_policies",
        `${action} gate${scopeBusinessId ? ` @ business ${scopeBusinessId}` : ""}${
          thresholdAmountGhs != null ? ` ≥ GH₵ ${thresholdAmountGhs}` : thresholdPercent != null ? ` ≥ ${thresholdPercent}%` : ""
        } → ${approverRole}`,
        "approval_policies",
        Number(row.id),
        scopeBusinessId,
        null,
        `Approver ${approverUserId ? `delegate #${approverUserId}` : approverRole}`,
        ownerId,
      );
      return NextResponse.json({ success: true, policy: row });
    }

    if (op === "POLICY_UPDATE" || op === "POLICY_DELETE") {
      const [policy] = await db.select().from(approvalPolicies).where(eq(approvalPolicies.id, Number(body?.policyId)));
      if (!policy) return NextResponse.json({ success: false, error: "Policy not found." }, { status: 404 });
      if (!user.isSuperAdmin && !myOrgs.has(Number(policy.ownerId))) {
        return FORBIDDEN("That policy belongs to another organization.");
      }
      if (role === "GENERAL_MANAGER" && op === "POLICY_DELETE") {
        return FORBIDDEN("Only the Owner can delete an approval policy.");
      }
      if (op === "POLICY_DELETE") {
        await db.delete(approvalPolicies).where(eq(approvalPolicies.id, policy.id));
        await auditLog(
          { id: user.id, name: user.name, role: user.role },
          "APPROVAL_POLICY_DELETE",
          "approval_policies",
          `${policy.action} gate (id ${policy.id})`,
          "approval_policies",
          Number(policy.id),
          policy.scopeBusinessId,
          null,
          null,
          Number(policy.ownerId),
        );
        return NextResponse.json({ success: true });
      }
      // POLICY_UPDATE — partial edit of the mutable fields.
      const set: any = { updatedAt: new Date() };
      if (body?.isActive !== undefined) set.isActive = !!body.isActive;
      if (body?.approverRole !== undefined) {
        const ar = String(body.approverRole).toUpperCase();
        if (!["OWNER", "GENERAL_MANAGER"].includes(ar)) {
          return NextResponse.json({ success: false, error: "approverRole must be OWNER or GENERAL_MANAGER." }, { status: 400 });
        }
        set.approverRole = ar;
      }
      if (body?.approverUserId !== undefined) set.approverUserId = Number(body.approverUserId) || null;
      if (body?.thresholdAmountGhs !== undefined) set.thresholdAmountGhs = cleanThreshold(body.thresholdAmountGhs);
      if (body?.thresholdPercent !== undefined) set.thresholdPercent = cleanThreshold(body.thresholdPercent);
      const [row] = await db
        .update(approvalPolicies)
        .set(set)
        .where(eq(approvalPolicies.id, policy.id))
        .returning();
      await auditLog(
        { id: user.id, name: user.name, role: user.role },
        "APPROVAL_POLICY_UPDATE",
        "approval_policies",
        `${policy.action} gate (id ${policy.id}) → ${row.isActive ? "active" : "inactive"}`,
        "approval_policies",
        Number(policy.id),
        policy.scopeBusinessId,
        null,
        JSON.stringify(set),
        Number(policy.ownerId),
      );
      return NextResponse.json({ success: true, policy: row });
    }

    return NextResponse.json({ success: false, error: "Unknown op." }, { status: 400 });
  } catch (error: any) {
    console.error("[api/approvals POST]", error);
    return NextResponse.json({ success: false, error: error?.message || "Approvals operation failed." }, { status: 500 });
  }
}
