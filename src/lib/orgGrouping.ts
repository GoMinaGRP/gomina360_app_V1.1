/**
 * Super-Admin "Organization Lens" helpers — pure functions shared by the
 * Sidebar, the Command Center oversight view and (mirrored) the lens
 * verification suite. Normal Owners never see any of this: every caller
 * applies it only when currentUser.isSuperAdmin is true.
 *
 * Lens model:
 *   "MY"   → the Main Owner's own workspace (organization #1)
 *   "ALL"  → platform-wide oversight (every organization, fused)
 *   "<id>" → one specific Owner/Organization
 */

export type OrgLite = { id: number; name: string; status?: string; slug?: string };

export type OrgGroup = {
  orgId: number;
  orgName: string;
  orgStatus: string;
  /** First business crest available inside the group — the org's visual id. */
  orgLogo: string | null;
  isMain: boolean;
  businesses: any[];
};

/** Group a business list by owning organization; the MAIN WORKSPACE (org 1)
 *  always sorts first, then every other Owner alphabetically by name. */
export function groupBusinessesByOrg(businesses: any[], organizations: OrgLite[]): OrgGroup[] {
  const byId = new Map(organizations.map((o) => [Number(o.id), o]));
  const buckets = new Map<number, any[]>();
  for (const b of businesses) {
    const oid = Number(b?.ownerId ?? 1);
    if (!buckets.has(oid)) buckets.set(oid, []);
    buckets.get(oid)!.push(b);
  }
  const groups = [...buckets.entries()].map(([orgId, biz]) => {
    const org = byId.get(orgId);
    const crest = biz.find((b: any) => b?.logo)?.logo ?? null;
    return {
      orgId,
      orgName: org?.name || (orgId === 1 ? "GoMina Group" : `Organization #${orgId}`),
      orgStatus: (org?.status || "ACTIVE").toUpperCase(),
      orgLogo: crest,
      isMain: orgId === 1,
      businesses: [...biz].sort((x, y) => Number(x.id) - Number(y.id)),
    } as OrgGroup;
  });
  groups.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.orgName.localeCompare(b.orgName);
  });
  return groups;
}

export type OrgRollup = {
  orgId: number;
  orgName: string;
  orgStatus: string;
  orgLogo: string | null;
  isMain: boolean;
  units: number;
  revenueGhs: number;
  expensesGhs: number;
  netProfitGhs: number;
  cashFlowGhs: number;
};

/** Per-organization financial rollup for the platform oversight view.
 *  `metricRows` must be the LIVE-blended rows (businessId-keyed revenue etc.) */
export function rollupsByOrg(businesses: any[], metricRows: any[], organizations: OrgLite[]): OrgRollup[] {
  const metricByBiz = new Map(metricRows.map((m: any) => [Number(m.businessId), m]));
  const byId = new Map(organizations.map((o) => [Number(o.id), o]));
  const buckets = new Map<number, any[]>();
  for (const o of organizations) buckets.set(Number(o.id), []);
  for (const b of businesses) {
    const oid = Number(b?.ownerId ?? 1);
    if (!buckets.has(oid)) buckets.set(oid, []);
    buckets.get(oid)!.push(b);
  }
  const rollups = [...buckets.entries()].map(([orgId, biz]) => {
    const org = byId.get(orgId);
    let revenue = 0, expenses = 0, net = 0, cash = 0;
    for (const b of biz) {
      const m = metricByBiz.get(Number(b.id));
      if (!m) continue;
      revenue += m.revenueGhs || 0;
      expenses += m.expensesGhs || 0;
      net += m.netProfitGhs || 0;
      cash += m.cashFlowGhs || 0;
    }
    return {
      orgId,
      orgName: org?.name || (orgId === 1 ? "GoMina Group" : `Organization #${orgId}`),
      orgStatus: (org?.status || "ACTIVE").toUpperCase(),
      orgLogo: biz.find((b: any) => b?.logo)?.logo ?? null,
      isMain: orgId === 1,
      units: biz.length,
      revenueGhs: revenue,
      expensesGhs: expenses,
      netProfitGhs: net,
      cashFlowGhs: cash,
    } as OrgRollup;
  });
  rollups.sort((a, b) => (a.isMain !== b.isMain ? (a.isMain ? -1 : 1) : a.orgName.localeCompare(b.orgName)));
  return rollups;
}
