import { formatMoney } from "./currency";

export type AquaAlertLevel = "critical" | "warning" | "normal";

export interface AquaAlert {
  id: string;
  level: AquaAlertLevel;
  category: string;
  title: string;
  message: string;
  recommendation: string;
  timestamp: string;
  value?: string;
  threshold?: string;
}

export interface AquaMetric {
  label: string;
  current: string;
  previous: string;
  changePct: number;
  trend: "improving" | "declining" | "stable";
  color: "green" | "yellow" | "red";
  unit?: string;
}

interface AquaAnalyticsInput {
  ponds: any[];
  batches: any[];
  feedLogs: any[];
  waterLogs: any[];
  harvests: any[];
  checklists: any[];
  transactions: any[];
  currentCurrency: string;
}

const t = (dateStr?: string) => dateStr || new Date().toISOString().split("T")[0];
const daysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0];
};
const pct = (c: number, p: number) => p === 0 ? (c === 0 ? 0 : 100) : ((c - p) / p) * 100;

export function analyzeAquaculture(data: AquaAnalyticsInput): {
  alerts: AquaAlert[];
  metrics: AquaMetric[];
  healthScore: number;
  statusColor: "green" | "yellow" | "red";
} {
  const { ponds, batches, feedLogs, waterLogs, harvests, checklists, transactions } = data;
  const alerts: AquaAlert[] = [];
  const metrics: AquaMetric[] = [];
  const today = new Date().toISOString().split("T")[0];
  const lastWeek = daysAgo(7);
  const lastMonth = daysAgo(30);

  // ── 1. MORTALITY / STOCK ─────────────────────────────────────────
  const totalInitial = batches.reduce((s, b) => s + (b.initialCount || 0), 0);
  const totalCurrent = batches.filter((b) => b.status === "GROWING").reduce((s, b) => s + (b.currentCount || 0), 0);
  const totalMortality = batches.reduce((s, b) => s + (b.mortalityTotal || 0), 0);
  const mortalityRate = totalInitial > 0 ? (totalMortality / totalInitial) * 100 : 0;

  if (mortalityRate > 15) {
    alerts.push({ id: "mort-critical", level: "critical", category: "Mortality", title: "Critical Mortality Rate", message: `Overall mortality is ${mortalityRate.toFixed(1)}% (above 15% danger zone). ${totalMortality.toLocaleString()} fish lost since stocking.`, recommendation: "Conduct immediate water quality inspection, check for infection (Ich, bacterial hemorrhagic septicemia), and separate/remove diseased fish. Consult a vet.", timestamp: today, value: `${mortalityRate.toFixed(1)}%`, threshold: "< 15%" });
  } else if (mortalityRate > 8) {
    alerts.push({ id: "mort-warning", level: "warning", category: "Mortality", title: "Elevated Mortality", message: `Mortality is elevated at ${mortalityRate.toFixed(1)}% across all batches.`, recommendation: "Monitor closely and conduct water tests immediately. Consider increasing aeration and cleaning filters daily.", timestamp: today, value: `${mortalityRate.toFixed(1)}%`, threshold: "< 8%" });
  } else {
    alerts.push({ id: "mort-normal", level: "normal", category: "Mortality", title: "Healthy Mortality Rate", message: `Overall mortality is ${mortalityRate.toFixed(1)}% — within acceptable range for tilapia/catfish culture.`, recommendation: "Maintain current water quality management and feeding routines.", timestamp: today, value: `${mortalityRate.toFixed(1)}%`, threshold: "< 8%" });
  }

  // ── 2. WATER QUALITY ────────────────────────────────────────────
  const latestWaterByPond: Record<number, any> = {};
  waterLogs.sort((a, b) => (a.sampleDate || "").localeCompare(b.sampleDate || "")).forEach((w) => {
    latestWaterByPond[w.pondId] = w;
  });

  Object.values(latestWaterByPond).forEach((w: any) => {
    const pond = ponds.find((p) => p.id === w.pondId);
    const pondName = pond?.name || `Pond #${w.pondId}`;
    const doMin = pond?.doTargetMinMgL ?? 5.0;
    const phMin = pond?.phTargetMin ?? 6.5;
    const phMax = pond?.phTargetMax ?? 8.5;

    if ((w.dissolvedOxygenMgL || 0) < doMin) {
      alerts.push({ id: `do-crit-${w.pondId}`, level: "critical", category: "Water Quality", title: `Critical Low DO in ${pondName}`, message: `Dissolved oxygen is ${w.dissolvedOxygenMgL} mg/L (target minimum ${doMin} mg/L). Fish will suffocate.`, recommendation: "Activate additional aeration immediately. Check aerator functions, reduce overstocking, and replace water if necessary.", timestamp: today, value: `${w.dissolvedOxygenMgL} mg/L`, threshold: `>${doMin} mg/L` });
    } else if ((w.dissolvedOxygenMgL || 0) < doMin + 1) {
      alerts.push({ id: `do-warning-${w.pondId}`, level: "warning", category: "Water Quality", title: `Low DO Warning: ${pondName}`, message: `DO is ${w.dissolvedOxygenMgL} mg/L, approaching minimum safe level.`, recommendation: "Increase aeration. Verify tank cleanliness, remove uneaten feed, and monitor temperature (higher temp = lower DO).", timestamp: today, value: `${w.dissolvedOxygenMgrL?.toFixed(1) || w.dissolvedOxygenMgL} mg/L`, threshold: `>${doMin} mg/L` });
    } else if ((w.dissolvedOxygenMgL || 0) < doMin + 1) {
      alerts.push({ id: `do-warning-${w.pondId}`, level: "warning", category: "Water Quality", title: `Low DO Warning: ${pondName}`, message: `DO is ${w.dissolvedOxygenMgL} mg/L, approaching minimum safe level.`, recommendation: "Increase aeration. Verify tank cleanliness, remove uneaten feed, and monitor temperature (higher temp = lower DO).", timestamp: today, value: `${(w.dissolvedOxygenMgL || 0).toFixed(1)} mg/L`, threshold: `>${doMin} mg/L` });
    }

    const ph = w.phLevel || 0;
    if (ph < phMin - 0.2 || ph > phMax + 0.2) {
      alerts.push({ id: `ph-crit-${w.pondId}`, level: "critical", category: "Water Quality", title: `pH Out of Range: ${pondName}`, message: `Water pH is ${ph.toFixed(2)} (target ${phMin} – ${phMax}). Extreme pH kills fish quickly.`, recommendation: `Add limestone (if acidic) or water exchange (if alkaline). Do not add lime during ammonia-afflicted conditions. Test ammonia immediately.`, timestamp: today, value: `${ph.toFixed(2)}`, threshold: `${phMin} – ${phMax}` });
    } else if (ph < phMin || ph > phMax) {
      alerts.push({ id: `ph-warning-${w.pondId}`, level: "warning", category: "Water Quality", title: `pH Outside Target: ${pondName}`, message: `pH is ${ph.toFixed(2)} outside the ideal ${phMin} – ${phMax} range.`, recommendation: "Partial water exchange, add agricultural lime cautiously, and monitor daily until the pH stabilizes.", timestamp: today, value: `${ph.toFixed(2)}`, threshold: `${phMin} – ${phMax}` });
    }

    if ((w.ammoniaMgL || 0) > 0.2) {
      alerts.push({ id: `nh3-crit-${w.pondId}`, level: "critical", category: "Water Quality", title: `High Ammonia in ${pondName}`, message: `Ammonia is ${w.ammoniaMgL} mg/L (toxic level is >0.2 mg/L for tilapia). Ammonia gills burns rapidly.`, recommendation: "Perform 50% water exchange immediately, remove uneaten feed, stop feeding for 24 hours, and add a bacterial probiotic culture.", timestamp: today, value: `${w.ammoniaMgL} mg/L`, threshold: "< 0.2 mg/L" });
    }
  });

  if (Object.values(latestWaterByPond).every((w: any) => (w.dissolvedOxygenMgL || 0) >= 6 && (w.phLevel || 0) >= 6.5 && (w.phLevel || 0) <= 8.5)) {
    alerts.push({ id: "wq-normal", level: "normal", category: "Water Quality", title: "Water Quality Normal", message: "All ponds and cages show acceptable DO, pH, and ammonia readings.", recommendation: "Continue daily water testing and routine filter cleaning.", timestamp: today, value: "All clear", threshold: "—" });
  }

  metrics.push({
    label: "Water Quality", current: Object.keys(latestWaterByPond).length + " ponds tested", previous: waterLogs.length + " total logs",
    changePct: 0, trend: "stable", color: "green",
  });

  // ── 3. FEED CONSUMPTION & EFFICIENCY (FCR) ──────────────────────
  const feedToday = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) === today).reduce((s, f) => s + (f.quantityKg || 0), 0);
  const feedYesterday = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) === daysAgo(1)).reduce((s, f) => s + (f.quantityKg || 0), 0);
  const feedWeek = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) >= lastWeek).reduce((s, f) => s + (f.quantityKg || 0), 0);

  metrics.push({
    label: "Feed Intake", current: `${feedToday.toFixed(0)} kg`, previous: `${feedYesterday.toFixed(0)} kg`,
    changePct: pct(feedToday, feedYesterday), trend: feedToday > feedYesterday ? "declining" : "improving",
    color: feedToday >= feedYesterday ? "green" : "yellow",
  });

  // FCR estimation from recent harvest: weight gained over last 30 days / feed consumed over last 30 days
  const biomassGained = harvests.filter((h) => t(h.saleDate) >= lastMonth).reduce((s, h) => s + (h.totalWeightKg || 0), 0);
  const feedMonth = feedLogs.filter((f) => t(f.recordedDate) >= lastMonth).reduce((s, f) => s + (f.quantityKg || 0), 0);
  const fcrEstimate = biomassGained > 0 && feedMonth > 0 ? feedMonth / biomassGained : 0;

  if (fcrEstimate > 2.0) {
    alerts.push({ id: "fcr-crit", level: "critical", category: "Feed Efficiency", title: "Critical Feed Conversion Ratio", message: `Estimated FCR is ${fcrEstimate.toFixed(2)} (critical is > 2.0). You are losing money on feed.`, recommendation: "Check feed quality (low protein brands), reduce feeding frequency, adjust pellet size, review water quality (poor water = poor feed conversion), and review stocking density.", timestamp: today, value: `${fcrEstimate.toFixed(2)}`, threshold: "< 1.8" });
  } else if (fcrEstimate > 1.5) {
    alerts.push({ id: "fcr-warning", level: "warning", category: "Feed Efficiency", title: "Poor Feed Efficiency", message: `Estimated FCR is ${fcrEstimate.toFixed(2)} (ideal is < 1.5 for tilapia).`, recommendation: "Monitor feed pellet size, review protein content (should be 30-35%), check for overfeeding (feed should be consumed within 5-10 minutes), and consider morning/evening split feeding.", timestamp: today, value: `${fcrEstimate.toFixed(2)}`, threshold: "< 1.5" });
  } else if (fcrEstimate > 0) {
    alerts.push({ id: "fcr-normal", level: "normal", category: "Feed Efficiency", title: "Feed Conversion Ratio Good", message: `Estimated FCR is ${fcrEstimate.toFixed(2)} — near the optimal tilapia range.`, recommendation: "Maintain current feeding schedule and continue monitoring weekly.", timestamp: today, value: `${fcrEstimate.toFixed(2)}`, threshold: "< 1.5" });
  }

  // ── 4. OVERSTOCKING / DENSITY ────────────────────────────────────
  ponds.forEach((pond: any) => {
    const utilization = (pond.currentBiomassKg || 0) / Math.max(pond.capacityLiters || 1, 1) * 100;
    if (utilization > 85) {
      alerts.push({ id: `stock-crit-${pond.id}`, level: "critical", category: "Overstocking", title: `Pond Overstocked: ${pond.name}`, message: `Stocking density is ${utilization.toFixed(0)}% of capacity. Overstocking causes ammonia buildup, oxygen drop, and high mortality.`, recommendation: "Harvest or thin the largest fish immediately. Prepare the next pond. Add extra aeration during transition.", timestamp: today, value: `${utilization.toFixed(0)}%`, threshold: "< 85%" });
    } else if (utilization > 70) {
      alerts.push({ id: `stock-warning-${pond.id}`, level: "warning", category: "Overstocking", title: `Heavy Stocking: ${pond.name}`, message: `Stocking density is ${utilization.toFixed(0)}% of pond capacity. Approaching dangerous levels.`, recommendation: "Plan for the next crop — secure alternative ponds or begin gradual thinning. Monitor water quality daily.", timestamp: today, value: `${utilization.toFixed(0)}%`, threshold: "< 70%" });
    }
  });

  // ── 5. HARVEST STATUS / APPROACHING ─────────────────────────────
  batches.filter((b) => b.status === "GROWING").forEach((batch: any) => {
    if (!batch.targetHarvestDate) return;
    const daysLeft = Math.ceil((new Date(batch.targetHarvestDate).getTime() - new Date(today).getTime()) / 86400000);
    if (daysLeft < 0) {
      alerts.push({ id: `harv-past-${batch.id}`, level: "critical", category: "Harvest", title: `Harvest Overdue: ${batch.batchNumber}`, message: `Target harvest date ${batch.targetHarvestDate} has passed. Fish are exceeding market weight and will reduce efficency daily.`, recommendation: "Schedule harvest this week. Late harvest causes FCR decline and poorer selling prices in Volta region.", timestamp: today, value: `${Math.abs(daysLeft)}d overdue`, threshold: "On time" });
    } else if (daysLeft <= 14) {
      alerts.push({ id: `harv-soon-${batch.id}`, level: "warning", category: "Harvest", title: `Harvest Approaching: ${batch.batchNumber}`, message: `Target harvest date (${batch.targetHarvestDate}) is in ${daysLeft} days.`, recommendation: "Begin packing arrangements. Confirm buyers, order packaging materials, and prepare cold storage.", timestamp: today, value: `${daysLeft}d left`, threshold: "2 weeks" });
    }
  });

  // ── 6. TASKS / MISSED ACTIONS ───────────────────────────────────
  const todayTasks = checklists.filter((c) => c.checklistDate === today);
  const done = todayTasks.filter((c) => c.isCompleted).length;
  const taskPct = todayTasks.length > 0 ? (done / todayTasks.length) * 100 : 100;

  if (taskPct < 50 && todayTasks.length > 0) {
    alerts.push({ id: "tasks-crit", level: "critical", category: "Daily Tasks", title: "Critical: Daily Tasks Missed", message: `Only ${done}/${todayTasks.length} daily aquaculture tasks completed.`, recommendation: "Complete feed dosing, water testing, mortality logging, and aerator inspection immediately.", timestamp: today, value: `${taskPct.toFixed(0)}%`, threshold: "100%" });
  } else if (taskPct < 80 && todayTasks.length > 0) {
    alerts.push({ id: "tasks-warning", level: "warning", category: "Daily Tasks", title: "Tasks Incomplete", message: `${taskPct.toFixed(0)}% of today's aquaculture routines are done.`, recommendation: "Finish remaining water tests and filter cleaning before end of shift.", timestamp: today, value: `${taskPct.toFixed(0)}%`, threshold: "90%" });
  } else {
    alerts.push({ id: "tasks-normal", level: "normal", category: "Daily Tasks", title: "All Tasks Completed", message: todayTasks.length > 0 ? "All daily aquaculture tasks completed successfully." : "No checklist created for today.", recommendation: "Keep executing daily aquaculture routines consistently.", timestamp: today, value: `${taskPct.toFixed(0)}%`, threshold: "90%" });
  }

  // ── 7. FINANCIAL RISKS ──────────────────────────────────────────
  const bizTrx = transactions;
  const incomeMonth = bizTrx.filter((tr) => tr.type === "INCOME" && tr.date >= lastMonth).reduce((s, tr) => s + (tr.amountGhs || 0), 0);
  const expensesMonth = bizTrx.filter((tr) => tr.type === "EXPENSE" && tr.date >= lastMonth).reduce((s, tr) => s + (tr.amountGhs || 0), 0);
  const profit = incomeMonth - expensesMonth;
  const margin = expensesMonth > 0 ? (profit / expensesMonth) * 100 : 0;

  if (profit < 0) {
    alerts.push({ id: "fin-crit", level: "critical", category: "Finance", title: "Negative Profit Alert", message: `Monthly profit is negative: ${formatMoney(profit, data.currentCurrency as any)}.`, recommendation: "Review feed costs (largest expense), electricity/generator fuel costs, and harvest pricing. Consider stabilizing fish prices in Akosombo market.", timestamp: today, value: formatMoney(profit, data.currentCurrency as any), threshold: "> 0" });
  } else if (margin < 15) {
    alerts.push({ id: "fin-warning", level: "warning", category: "Finance", title: "Thin Margin Warning", message: `Monthly profit margin is ${margin.toFixed(1)}% of expenses (should exceed 15%).`, recommendation: "Negotiate feed supplier rates, review selling prices per kg, and evaluate labor/electricity costs.", timestamp: today, value: `${margin.toFixed(1)}%`, threshold: "> 15%" });
  } else {
    alerts.push({ id: "fin-normal", level: "normal", category: "Finance", title: "Healthy Financial Status", message: `Monthly profit of ${formatMoney(profit, data.currentCurrency as any)} (${margin.toFixed(1)}% margin).`, recommendation: "Consider reinvesting profits into infrastructure or feed stock during lower price periods.", timestamp: today, value: `${margin.toFixed(1)}%`, threshold: "> 15%" });
  }

  // ── Score & composition ──
  const criticals = alerts.filter((a) => a.level === "critical").length;
  const warnings = alerts.filter((a) => a.level === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - criticals * 20 - warnings * 5));
  const statusColor = criticals > 0 ? "red" : warnings > 0 ? "yellow" : "green";

  metrics.push(
    { label: "Total Fish", current: totalCurrent.toLocaleString(), previous: `${totalInitial.toLocaleString()} placed`, changePct: 0, trend: "stable", color: "green" },
    { label: "Harvest Weight (30d)", current: biomassGained.toFixed(0) + "kg", previous: `${harvests.length} harvests`, changePct: 0, trend: "stable", color: "green" },
    { label: "Ponds Active", current: ponds.filter((p: any) => p.status !== "EMPTY").length.toString(), previous: `${ponds.length} total`, changePct: 0, trend: "stable", color: "green" },
  );

  return { alerts, metrics, healthScore: score, statusColor };
}

export const AQUA_ALERT_STYLES: Record<AquaAlertLevel, string> = {
  critical: "bg-rose-500/15 border-rose-500/40 text-rose-200",
  warning: "bg-amber-500/15 border-amber-500/40 text-amber-200",
  normal: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200",
};

export const AQUA_METRIC_COLORS: Record<string, string> = {
  green: "text-emerald-400 border-emerald-500/40",
  yellow: "text-amber-400 border-amber-500/40",
  red: "text-rose-400 border-rose-500/40",
};
