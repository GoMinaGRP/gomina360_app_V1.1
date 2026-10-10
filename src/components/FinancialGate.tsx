"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { canSeeFinancials } from "@/lib/permissions";

/**
 * FinancialGate — the shared chokepoint for money rendered OUTSIDE
 * <FinancialReportSection>.
 *
 * Why this exists next to the report's own gate: the report component derives
 * its P&L from the transactions it is handed, so gating the component closes
 * the report. But several business modules ALSO print a revenue / expenses /
 * net-profit strip in their Finance or Reports tab — a summary above or beside
 * the report rather than inside it. Those blocks were unguarded, which is how a
 * viewer the policy denies could still read "Revenue GH₵ 2.48k · Net Profit
 * GH₵ 2.48k · 100.0% margin" while the report beside it was correctly locked.
 *
 * Gating each of those call sites by hand does not hold up: the next module
 * adds another strip and forgets. So both surfaces now ask the same question
 * of the same predicate.
 *
 * A missing `user` denies — fail closed.
 */
export default function FinancialGate({
  user,
  children,
  title = "Financial figures are restricted",
  subtitle,
  accent = "amber",
  testid,
}: {
  user: any;
  children: ReactNode;
  title?: string;
  subtitle?: string;
  accent?: string;
  testid?: string;
}) {
  if (canSeeFinancials(user)) return <>{children}</>;

  return (
    <div
      data-testid={testid}
      className="rounded-2xl border border-amber-500/40 bg-slate-800/90 p-5 flex items-start gap-3"
    >
      <div className="w-10 h-10 rounded-xl border border-amber-500/40 bg-amber-500/10 flex items-center justify-center shrink-0">
        <Lock className="w-5 h-5 text-amber-300" />
      </div>
      <div className="min-w-0">
        <h3 className="text-base font-extrabold text-white">{title}</h3>
        {subtitle ? <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p> : null}
        <div className="mt-3 inline-flex items-start gap-2 px-3 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs font-semibold max-w-2xl">
          <span aria-hidden>🔒</span>
          <span>
            Financial figures are restricted to the OWNER and users the OWNER has authorised.
            Operational indicators stay live; ask the OWNER for the{" "}
            <strong>Finance &amp; Reports</strong> authorisation to see revenue, expenses,
            profit, cash flow and ROI.
          </span>
        </div>
      </div>
    </div>
  );
}