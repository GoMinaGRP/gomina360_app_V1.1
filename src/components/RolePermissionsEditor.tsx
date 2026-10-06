"use client";

/**
 * RolePermissionsEditor — the ONE permissions editor used by every surface that
 * creates or edits an account (Users & Access, Enterprise Users → Register /
 * Edit, Branch Manager worker panel).
 *
 * Why it exists (docs/ROLES-AND-PERMISSIONS-AUDIT.md F3):
 *   • The two consoles rendered different toggle sets — Enterprise Users showed
 *     4 capabilities, Users & Access showed 14 — against the same API.
 *   • Choosing a role changed nothing: toggles stayed where they were, so the
 *     role name predicted nothing about what the account could do.
 *
 * Now the toggles and their defaults come from the registry (src/lib/roles.ts):
 * picking a role applies that role's preset visibly, and the OWNER can override
 * any single toggle before saving. Payload shape is unchanged, so the server
 * contract is untouched.
 */

import React, { useMemo } from "react";
import {
  CAPABILITIES,
  capabilitiesForRole,
  isPresetModified,
  roleDef,
  rolePreset,
  type CapabilityKey,
} from "@/lib/roles";

export type CapabilityValues = Partial<Record<CapabilityKey, boolean>>;

export interface RolePermissionsEditorProps {
  /** The role currently selected in the form. */
  role: string;
  /** Current toggle values (a capability is ON only when strictly true). */
  values: CapabilityValues;
  onChange: (key: CapabilityKey, value: boolean) => void;
  /** Applying a whole preset at once (called when the role changes). */
  onApplyPreset?: (values: Record<CapabilityKey, boolean>) => void;
  /** Only the OWNER may flip the sensitive/OWNER-only capabilities. */
  /** Only the OWNER may grant/revoke OWNER-only capabilities. Defaults to
   *  false: the safe default is to show the role's everyday capabilities and
   *  let the server enforce the rest. */
  isOwner?: boolean;
  /** Hides capabilities that make no sense for the role (e.g. advisor). */
  showPresetHint?: boolean;
  /** compact = the 4-row grid used inside the register modal. */
  density?: "comfortable" | "compact";
  /** Prefix for the editor-level test ids (the toggles keep their canonical
   *  `perm-*` ids from the registry so every surface is addressable the same way). */
  testidPrefix?: string;
  disabled?: boolean;
}

/** Renders the role's blurb + the capability toggles + preset state. */
export default function RolePermissionsEditor({
  role,
  values,
  onChange,
  isOwner = false,
  showPresetHint = true,
  density = "comfortable",
  testidPrefix = "perm",
  disabled = false,
}: RolePermissionsEditorProps) {
  const def = roleDef(role);
  const preset = useMemo(() => rolePreset(role), [role]);
  const applicable = useMemo(() => capabilitiesForRole(role), [role]);
  const modified = useMemo(() => isPresetModified(role, values), [role, values]);

  /** Non-owners may only see the operational capabilities (mirrors the server). */
  const visible = isOwner
    ? applicable
    : applicable.filter((c) => !c.ownerOnly || values[c.key] === true);

  const isAdvisor = def?.key === "FARM_ADVISOR";
  const compact = density === "compact";

  return (
    <div className={compact ? "space-y-2" : "space-y-3"} data-testid={`${testidPrefix}-editor`}>
      {/* Role summary — so "Accountant" visibly means something before saving. */}
      {def && (
        <div
          className={`rounded-lg border px-3 py-2 ${
            isAdvisor
              ? "border-teal-500/30 bg-teal-500/5"
              : "border-slate-700/70 bg-slate-900/60"
          }`}
          data-testid={`${testidPrefix}-role-blurb`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-300">
              {def.label}
            </span>
            {showPresetHint && modified && (
              <span className="text-[10px] font-semibold text-amber-300" data-testid={`${testidPrefix}-modified`}>
                edited from the {def.shortLabel} preset
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 leading-snug mt-0.5">{def.blurb}</p>
        </div>
      )}

      {isAdvisor ? (
        <p
          className="text-[10px] text-teal-300 leading-snug"
          data-testid={`${testidPrefix}-advisor-note`}
        >
          Farm Advisor accounts are read-only by design: no branch, no management permissions. Every
          capability stays off and the API enforces it. Grant their farm units below (with an optional
          expiry) — that is their entire access.
        </p>
      ) : (
        <div className={compact ? "grid grid-cols-1 gap-1.5" : "space-y-1.5"}>
          {visible.map((cap) => {
            const on = values[cap.key] === true;
            const fromPreset = preset[cap.key] === true;
            return (
              <label
                key={cap.key}
                title={cap.hint}
                data-testid={cap.testid}
                className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 cursor-pointer select-none transition ${
                  on
                    ? cap.sensitive
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-cyan-500/40 bg-cyan-500/10"
                    : "border-slate-700/60 bg-slate-900/40 hover:border-slate-600"
                } ${disabled ? "opacity-60 pointer-events-none" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={(e) => onChange(cap.key, e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 accent-cyan-500"
                />
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold text-slate-200 leading-snug">
                    {cap.sensitive ? "🔒 " : ""}
                    {cap.label}
                  </span>
                  {cap.hint && !compact && (
                    <span className="block text-[10px] text-slate-500 leading-snug">{cap.hint}</span>
                  )}
                  {showPresetHint && fromPreset && !modified && (
                    <span className="block text-[9px] font-semibold uppercase tracking-wide text-cyan-400/80 mt-0.5">
                      {def?.shortLabel} preset
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {visible.length === 0 && (
            <p className="text-[10px] text-slate-500 italic">No capabilities apply to this role.</p>
          )}
        </div>
      )}

      {isOwner && !isAdvisor && (
        <p className="text-[10px] text-slate-500 leading-snug">
          You are the OWNER: every toggle above applies immediately and is recorded on the audit trail.
        </p>
      )}
    </div>
  );
}
