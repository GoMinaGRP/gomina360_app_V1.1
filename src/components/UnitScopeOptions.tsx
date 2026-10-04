"use client";

import { unitOptionGroups } from "@/lib/businessScope";
import { useOrgDirectory } from "@/components/OrgDirectoryContext";

/**
 * UnitScopeOptions — the shared <option> list for every flat unit <select>.
 *
 * Adopt this instead of hand-rolling `businesses.map(...)`: the labels, the
 * owner grouping (own workspace first) and the counts then match the scope bar
 * used by Audit & Review, Manage Units and the Export Center. A single-owner
 * list renders exactly as before — plain options, no optgroups — so nothing
 * gets noisier for the common case.
 *
 * The parent keeps its own <select> (classes, testid, onChange); only the
 * option children are shared.
 */
export default function UnitScopeOptions({
  units,
  organizations,
  myOrgId,
  allValue = "",
  allLabel = "All units",
  includeAll = true,
  showCode = false,
}: {
  /** The units already narrowed for the caller (the app passes scopedBusinesses). */
  units: any[] | null | undefined;
  /** Owner directory — only Super Admin payloads carry one. */
  organizations?: { id: number; name?: string | null }[] | null;
  /** The caller's own organization, so their workspace sorts first. */
  myOrgId?: number;
  /** Sentinel value for the "no unit chosen" row. */
  allValue?: string;
  allLabel?: string;
  includeAll?: boolean;
  /** Render "Name (CODE)" labels (some panels already did). */
  showCode?: boolean;
}) {
  const directory = useOrgDirectory();
  const groups = unitOptionGroups(units, { organizations: organizations ?? directory, myOrgId });
  const labelOf = (u: { name: string; code: string | null }) =>
    showCode && u.code ? `${u.name} (${u.code})` : u.name;
  return (
    <>
      {includeAll && <option value={allValue}>{allLabel}</option>}
      {groups.length <= 1
        ? (groups[0]?.units || []).map((u) => (
            <option key={u.id} value={u.id}>
              {labelOf(u)}
            </option>
          ))
        : groups.map((g) => (
            <optgroup key={g.ownerId} label={`${g.ownerName} (${g.units.length})`}>
              {g.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {labelOf(u)}
                </option>
              ))}
            </optgroup>
          ))}
    </>
  );
}
