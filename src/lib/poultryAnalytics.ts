import { formatMoney } from "./currency";

export type AlertLevel = "critical" | "warning" | "normal";

export interface PoultryAlert {
  id: string;
  level: AlertLevel;
  category: string;
  title: string;
  message: string;
  recommendation: string;
  timestamp: string;
  value?: string;
  threshold?: string;
}

export interface PerformanceMetric {
  label: string;
  current: string;
  previous: string;
  changePct: number;
  status: "UP" | "DOWN" | "FLAT";
  trend: "improving" | "declining" | "stable";
  color: "green" | "yellow" | "red";
  unit?: string;
}

interface PoultryAnalyticsInput {
  flocks: any[];
  feedLogs: any[];
  waterLogs: any[];
  healthRecords: any[];
  production: any[];
  checklists: any[];
  inventory: any[];
  transactions: any[];
  currentCurrency: string;
}

const t = (dateStr?: string) => (dateStr || new Date().toISOString().split("T")[0]);

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}

export function analyzePoultry(data: PoultryAnalyticsInput): {
  alerts: PoultryAlert[];
  metrics: PerformanceMetric[];
  healthScore: number; // 0-100
  statusColor: "green" | "yellow" | "red";
} {
  const { flocks, feedLogs, waterLogs, healthRecords, production, checklists, inventory, transactions } = data;
  const alerts: PoultryAlert[] = [];
  const metrics: PerformanceMetric[] = [];

  // ── Active flock baselines ──
  const activeFlocks = flocks.filter((f) => f.status === "ACTIVE" || f.status === "GROWING");
  const totalBirds = activeFlocks.reduce((s, f) => s + (f.currentCount || 0), 0);
  const today = new Date().toISOString().split("T")[0];
  const yesterday = daysAgo(1);
  const lastWeek = daysAgo(7);
  const twoWeeksAgo = daysAgo(14);
  const lastMonth = daysAgo(30);

  // ── 1. MORTALITY ANALYSIS ─────────────────────────────────────────
  const totalMortality = flocks.reduce((s, f) => s + (f.mortalityTotal || 0), 0);
  const totalInitial = flocks.reduce((s, f) => s + (f.initialCount || 0), 0);
  const mortalityRate = totalInitial > 0 ? (totalMortality / totalInitial) * 100 : 0;

  // Mortality from health records in last 7 days
  const mortalityThisWeek = healthRecords
    .filter((h) => (h.mortalityCount || 0) > 0 && t(h.recordedDate) >= lastWeek)
    .reduce((s, h) => s + (h.mortalityCount || 0), 0);
  const mortalityPrevWeek = healthRecords
    .filter((h) => (h.mortalityCount || 0) > 0 && t(h.recordedDate) >= twoWeeksAgo && t(h.recordedDate) < lastWeek)
    .reduce((s, h) => s + (h.mortalityCount || 0), 0);

  let avgDailyBirds = Math.max(totalBirds, 1);
  const mortalityPctToday = totalBirds > 0 ? (mortalityThisWeek / 7 / avgDailyBirds) * 100 : 0;

  if (mortalityPctToday > 1.0) {
    alerts.push({
      id: "mortality-critical", level: "critical", category: "Mortality",
      title: "Critical Mortality Rate",
      message: `Daily mortality is ${mortalityPctToday.toFixed(2)}% (above 1% danger threshold). ${mortalityThisWeek} birds lost this week.`,
      recommendation: "Perform immediate flock inspection. Check for disease signs (Newcastle, Gumboro), verify feed/water access, and consult a veterinarian today.",
      timestamp: today, value: `${mortalityPctToday.toFixed(2)}%/day`, threshold: "> 1%/day",
    });
  } else if (mortalityPctToday > 0.5) {
    alerts.push({
      id: "mortality-warning", level: "warning", category: "Mortality",
      title: "Elevated Mortality",
      message: `Daily mortality is ${mortalityPctToday.toFixed(2)}% (above normal 0.1–0.5% range).`,
      recommendation: "Check for heat stress, water availability, and early disease symptoms. Increase flock monitoring frequency.",
      timestamp: today, value: `${mortalityPctToday.toFixed(2)}%/day`, threshold: "0.1–0.5%",
    });
  } else {
    alerts.push({
      id: "mortality-normal", level: "normal", category: "Mortality",
      title: "Mortality Within Normal Range",
      message: `Daily mortality is healthy at ${mortalityPctToday.toFixed(2)}%. Overall flock mortality rate is ${mortalityRate.toFixed(1)}%.`,
      recommendation: "Continue current flock management. Maintain biosecurity and feeding routines.",
      timestamp: today, value: `${mortalityPctToday.toFixed(2)}%/day`, threshold: "< 0.5%",
    });
  }

  metrics.push({
    label: "Mortality Rate", current: `${mortalityPctToday.toFixed(2)}%/day`, previous: `${mortalityPrevWeek}/7 days`,
    changePct: pctChange(mortalityThisWeek, mortalityPrevWeek),
    status: mortalityThisWeek > mortalityPrevWeek ? "UP" : mortalityThisWeek < mortalityPrevWeek ? "DOWN" : "FLAT",
    trend: mortalityThisWeek > mortalityPrevWeek ? "declining" : "improving",
    color: mortalityThisWeek > mortalityPrevWeek ? "red" : "green", unit: "%",
  });

  // ── 2. FEED INTAKE ANALYSIS ──────────────────────────────────────
  const feedToday = feedLogs
    .filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) === today)
    .reduce((s, f) => s + (f.quantityKg || 0), 0);
  const feedYesterday = feedLogs
    .filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) === yesterday)
    .reduce((s, f) => s + (f.quantityKg || 0), 0);
  const feedWeekAvg = (() => {
    const last7 = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && t(f.recordedDate) >= lastWeek);
    const days = new Set(last7.map((f) => t(f.recordedDate))).size;
    return days > 0 ? last7.reduce((s, f) => s + (f.quantityKg || 0), 0) / days : 0;
  })();

  const feedPerBirdToday = totalBirds > 0 ? feedToday / totalBirds : 0;
  const expectedFeedPerBird = 0.110; // ~110g per day for layers
  const feedRatio = expectedFeedPerBird > 0 ? feedPerBirdToday / expectedFeedPerBird : 0;

  if (feedToday === 0 && feedWeekAvg > 0) {
    alerts.push({
      id: "feed-zero", level: "critical", category: "Feed Intake",
      title: "No Feed Consumption Recorded Today",
      message: "No feed intake has been logged today. This may indicate a feed outage or recording gap.",
      recommendation: "Immediately verify feed availability in all hoppers and ensure feeding records are complete.",
      timestamp: today, value: "0 kg", threshold: `${feedWeekAvg.toFixed(0)} kg avg`,
    });
  } else if (feedRatio < 0.7 && feedRatio > 0) {
    alerts.push({
      id: "feed-low", level: "warning", category: "Feed Intake",
      title: "Feed Intake Below Normal",
      message: `Feed intake is ${(feedRatio * 100).toFixed(0)}% of expected ${(expectedFeedPerBird * 1000).toFixed(0)}g/bird/day. This can reduce egg production and broiler growth.`,
      recommendation: "Check drinkers (birds eat less when thirsty), inspect feed quality, and check house temperature. Ensure feed is fresh and not spoiled.",
      timestamp: today, value: `${(feedPerBirdToday * 1000).toFixed(0)}g/bird`, threshold: `${(expectedFeedPerBird * 1000).toFixed(0)}g/bird`,
    });
  } else {
    alerts.push({
      id: "feed-normal", level: "normal", category: "Feed Intake",
      title: "Feed Intake Normal",
      message: `Feed consumption is ${(feedPerBirdToday * 1000).toFixed(0)}g/bird today, within expected range.`,
      recommendation: "Maintain feeding routine.",
      timestamp: today, value: `${(feedPerBirdToday * 1000).toFixed(0)}g/bird`, threshold: `${(expectedFeedPerBird * 1000).toFixed(0)}g/bird`,
    });
  }

  metrics.push({
    label: "Feed Intake", current: `${feedToday.toFixed(0)} kg`, previous: `${feedYesterday.toFixed(0)} kg`,
    changePct: pctChange(feedToday, feedYesterday),
    status: feedToday > feedYesterday ? "UP" : feedToday < feedYesterday ? "DOWN" : "FLAT",
    trend: feedToday > feedYesterday ? "declining" : "improving",
    color: feedToday >= feedYesterday ? "green" : "yellow", unit: "kg",
  });

  // ── 3. WATER ANALYSIS ────────────────────────────────────────────
  const waterToday = waterLogs.filter((w) => t(w.recordedDate) === today).reduce((s, w) => s + (w.volumeLiters || 0), 0);
  const waterYesterday = waterLogs.filter((w) => t(w.recordedDate) === yesterday).reduce((s, w) => s + (w.volumeLiters || 0), 0);
  const waterWeekAvg = (() => {
    const last7 = waterLogs.filter((w) => t(w.recordedDate) >= lastWeek);
    const days = new Set(last7.map((w) => t(w.recordedDate))).size;
    return days > 0 ? last7.reduce((s, w) => s + (w.volumeLiters || 0), 0) / days : 0;
  })();

  const waterPerBirdToday = totalBirds > 0 ? waterToday / totalBirds : 0;
  // Birds typically drink ~2x feed weight. For layers ~220-300ml/day
  const expectedWaterPerBird = 0.25; // liters
  const waterRatio = expectedWaterPerBird > 0 ? waterPerBirdToday / expectedWaterPerBird : 0;

  if (waterToday === 0 && waterWeekAvg > 0) {
    alerts.push({
      id: "water-zero", level: "critical", category: "Water",
      title: "No Water Consumption Recorded",
      message: "No water intake has been logged today. Dehydration is a critical emergency for poultry.",
      recommendation: "Check water lines immediately. Birds can show production drops within hours of water loss.",
      timestamp: today, value: "0 L", threshold: `${waterWeekAvg.toFixed(0)} L avg`,
    });
  } else if (waterRatio < 0.6) {
    alerts.push({
      id: "water-low", level: "warning", category: "Water",
      title: "Water Intake Below Normal",
      message: `Water consumption is ${(waterRatio * 100).toFixed(0)}% of expected ~250ml/bird/day. Dehydration reduces feed intake and egg quality.`,
      recommendation: "Inspect nipple drinkers for blockage, check water pressure, and ensure clean fresh water. Consider heat stress if temperatures are high.",
      timestamp: today, value: `${(waterPerBirdToday * 1000).toFixed(0)}ml/bird`, threshold: "250ml/bird",
    });
  } else {
    alerts.push({
      id: "water-normal", level: "normal", category: "Water",
      title: "Water Intake Normal",
      message: `Water consumption is ${(waterPerBirdToday * 1000).toFixed(0)}ml/bird today.`,
      recommendation: "Maintain drinking water quality and availability.",
      timestamp: today, value: `${(waterPerBirdToday * 1000).toFixed(0)}ml/bird`, threshold: "225–300ml/bird",
    });
  }

  metrics.push({
    label: "Water Intake", current: `${waterToday.toFixed(0)} L`, previous: `${waterYesterday.toFixed(0)} L`,
    changePct: pctChange(waterToday, waterYesterday),
    status: waterToday > waterYesterday ? "UP" : waterToday < waterYesterday ? "DOWN" : "FLAT",
    trend: waterToday > waterYesterday ? "declining" : "improving",
    color: waterToday >= waterYesterday ? "green" : "yellow", unit: "L",
  });

  // ── 4. EGG PRODUCTION ANALYSIS ───────────────────────────────────
  const eggsToday = production.filter((p) => p.productionType === "EGGS" && t(p.recordedDate) === today).reduce((s, p) => s + (p.eggsCollected || 0), 0);
  const eggsYesterday = production.filter((p) => p.productionType === "EGGS" && t(p.recordedDate) === yesterday).reduce((s, p) => s + (p.eggsCollected || 0), 0);
  const eggsWeekAvg = (() => {
    const last7 = production.filter((p) => p.productionType === "EGGS" && t(p.recordedDate) >= lastWeek);
    const days = new Set(last7.map((p) => t(p.recordedDate))).size;
    return days > 0 ? last7.reduce((s, p) => s + (p.eggsCollected || 0), 0) / days : 0;
  })();
  const eggsMonthAvg = (() => {
    const last30 = production.filter((p) => p.productionType === "EGGS" && t(p.recordedDate) >= lastMonth);
    const days = new Set(last30.map((p) => t(p.recordedDate))).size;
    return days > 0 ? last30.reduce((s, p) => s + (p.eggsCollected || 0), 0) / days : 0;
  })();

  const layPctToday = totalBirds > 0 ? (eggsToday / totalBirds) * 100 : 0;
  const expectedLayPct = 85; // ~85% for layers

  if (layPctToday > 0 && layPctToday < expectedLayPct * 0.65) {
    alerts.push({
      id: "egg-critical", level: "critical", category: "Egg Production",
      title: "Severe Drop in Egg Production",
      message: `Lay rate is ${layPctToday.toFixed(1)}%, well below the expected ${expectedLayPct}%. This often signals disease, stress, or nutrition problems.`,
      recommendation: "Investigate immediately: feed quality/quantity, water availability, disease symptoms (check for respiratory signs, lethargy), lighting program, and heat stress. Consider consulting a vet.",
      timestamp: today, value: `${layPctToday.toFixed(1)}%`, threshold: `${expectedLayPct}%`,
    });
  } else if (layPctToday > 0 && layPctToday < expectedLayPct * 0.85) {
    alerts.push({
      id: "egg-warning", level: "warning", category: "Egg Production",
      title: "Egg Production Below Target",
      message: `Lay rate is ${layPctToday.toFixed(1)}% (target ~${expectedLayPct}%). Production has dipped below acceptable levels.`,
      recommendation: "Review feeding program, calorie intake, water quality, and check for stress factors. Verify lighting is 14-16 hours.",
      timestamp: today, value: `${layPctToday.toFixed(1)}%`, threshold: `${expectedLayPct}%`,
    });
  } else {
    alerts.push({
      id: "egg-normal", level: "normal", category: "Egg Production",
      title: "Egg Production Healthy",
      message: `Lay rate today is ${layPctToday.toFixed(1)}% (${eggsToday} eggs). Production is within healthy range.`,
      recommendation: "Continue current feeding and management practices.",
      timestamp: today, value: `${layPctToday.toFixed(1)}%`, threshold: `${expectedLayPct}%`,
    });
  }

  metrics.push({
    label: "Egg Production", current: `${eggsToday} eggs`, previous: `${eggsYesterday} eggs`,
    changePct: pctChange(eggsToday, eggsYesterday),
    status: eggsToday > eggsYesterday ? "UP" : eggsToday < eggsYesterday ? "DOWN" : "FLAT",
    trend: eggsToday > eggsYesterday ? "declining" : "improving",
    color: eggsToday >= eggsYesterday ? "green" : layPctToday < expectedLayPct * 0.85 ? "red" : "yellow",
  });

  // ── 5. BROILER WEIGHT ANALYSIS ───────────────────────────────────
  const broilerProd = production.filter((p) => p.productionType !== "EGGS" || (p.avgWeightKg || 0) > 0);
  const lastBroilerWeight = broilerProd.length > 0 ? broilerProd[broilerProd.length - 1]?.avgWeightKg || 0 : 0;
  const prevBroilerWeight = broilerProd.length > 1 ? broilerProd[broilerProd.length - 2]?.avgWeightKg || 0 : 0;

  if (lastBroilerWeight > 0 && prevBroilerWeight > 0 && lastBroilerWeight < prevBroilerWeight) {
    alerts.push({
      id: "weight-decline", level: "warning", category: "Broiler Weight",
      title: "Broiler Weight Declining",
      message: `Average broiler weight dropped from ${prevBroilerWeight}kg to ${lastBroilerWeight}kg. This indicates poor growth or illness.`,
      recommendation: "Review feed intake and quality, check for coccidiosis/illness, and consider increasing feed frequency.",
      timestamp: today, value: `${lastBroilerWeight}kg`, threshold: `${prevBroilerWeight}kg`,
    });
  } else if (lastBroilerWeight > 0) {
    alerts.push({
      id: "weight-normal", level: "normal", category: "Broiler Weight",
      title: "Broiler Weight Tracking",
      message: `Current average broiler weight is ${lastBroilerWeight}kg.`,
      recommendation: "Continue to monitor growth against breed standard curves.",
      timestamp: today, value: `${lastBroilerWeight}kg`, threshold: "Breed standard",
    });
  }

  // ── 6. DISEASE / HEALTH SYMPTOMS ────────────────────────────────
  const sickRecords = healthRecords.filter((h) => h.recordType === "TREATMENT" || h.diseaseOrCondition);
  const recentSick = sickRecords.filter((h) => t(h.recordedDate) >= lastWeek);

  if (recentSick.length > 0) {
    const diseases = [...new Set(recentSick.map((h) => h.diseaseOrCondition || h.recordType))].slice(0, 3);
    alerts.push({
      id: "disease-warning", level: "warning", category: "Health / Disease",
      title: "Active Health Issues Detected",
      message: `${recentSick.length} recent health records with conditions: ${diseases.join(", ")}. Birds in flock may be affected.`,
      recommendation: "Quarantine affected birds, increase biosecurity, monitor all houses daily, and consult a veterinarian for proper treatment protocol.",
      timestamp: today, value: `${recentSick.length} records`, threshold: "0 active",
    });
  } else {
    alerts.push({
      id: "disease-normal", level: "normal", category: "Health",
      title: "No Active Disease Reports",
      message: "No recent disease or treatment records. Flock appears healthy.",
      recommendation: "Maintain biosecurity and vaccination schedule.",
      timestamp: today, value: "0", threshold: "0",
    });
  }

  // ── 7. CHECKLIST COMPLETION ─────────────────────────────────────
  const todayTasks = checklists.filter((c) => t(c.checklistDate) === today);
  const todayDone = todayTasks.filter((c) => c.isCompleted).length;
  const checklistPct = todayTasks.length > 0 ? (todayDone / todayTasks.length) * 100 : 100;

  if (checklistPct < 50 && todayTasks.length > 0) {
    alerts.push({
      id: "checklist-warning", level: "warning", category: "Daily Routine",
      title: "Daily Checklist Incomplete",
      message: `Only ${todayDone}/${todayTasks.length} daily tasks completed (${checklistPct.toFixed(0)}%).`,
      recommendation: "Complete essential feeding, water, egg collection, and mortality checks immediately.",
      timestamp: today, value: `${checklistPct.toFixed(0)}%`, threshold: "100%",
    });
  } else {
    alerts.push({
      id: "checklist-normal", level: "normal", category: "Daily Routine",
      title: "Daily Checklist Complete",
      message: todayTasks.length > 0 ? `All ${todayTasks.length} daily tasks completed.` : "No checklist tasks for today yet.",
      recommendation: "Keep maintaining daily routine.",
      timestamp: today, value: `${checklistPct.toFixed(0)}%`, threshold: "100%",
    });
  }

  // ── 8. INVENTORY & STOCK ALERTS ─────────────────────────────────
  const lowInventory = inventory.filter((i) => i.status === "LOW_STOCK" || i.quantity <= i.minStockThreshold);
  const outInventory = inventory.filter((i) => i.status === "OUT_OF_STOCK" || i.quantity <= 0);

  // Feed stock: sum of feed-related inventory (category feed, or word feed in name)
  const feedStockItems = inventory.filter((i) => /feed|mash|concentrate/i.test(`${i.name} ${i.category}`));
  const feedStockKg = feedStockItems.reduce((s, i) => s + (i.quantity || 0), 0);
  const feedConsumptionWeek = feedLogs
    .filter((f) => f.entryType === "CONSUMPTION")
    .reduce((s, f) => s + (f.quantityKg || 0), 0);
  const daysOfFeed = feedConsumptionWeek > 0 ? feedStockKg / (feedConsumptionWeek / 7) : 999;

  if (outInventory.length > 0) {
    alerts.push({
      id: "stock-out", level: "critical", category: "Inventory",
      title: "Items Out of Stock",
      message: `${outInventory.length} inventory item(s) are out of stock.`,
      recommendation: "Re-order immediately. Out-of-stock items disrupt farm operations.",
      timestamp: today, value: `${outInventory.length} OOS`, threshold: "0",
    });
  }

  if (lowInventory.length > 0) {
    alerts.push({
      id: "low-stock", level: "warning", category: "Inventory",
      title: "Low Stock Alert",
      message: `${lowInventory.length} inventory item(s) are at/below minimum threshold: ${lowInventory.map((i) => i.name).slice(0, 3).join(", ")}.`,
      recommendation: "Place re-orders for the flagged items to avoid stockouts.",
      timestamp: today, value: `${lowInventory.length} low`, threshold: "0",
    });
  }

  if (feedStockKg > 0 && daysOfFeed < 7) {
    alerts.push({
      id: "feed-stock-low", level: "warning", category: "Feed Stock",
      title: "Feed Stock Running Low",
      message: `Only ${daysOfFeed.toFixed(1)} days of feed remaining (${feedStockKg.toFixed(0)} kg).`,
      recommendation: "Order feed now — delivery typically takes 2–5 days.",
      timestamp: today, value: `${daysOfFeed.toFixed(1)} days`, threshold: "7 days",
    });
  } else {
    alerts.push({
      id: "feed-stock-ok", level: "normal", category: "Feed Stock",
      title: "Feed Stock Adequate",
      message: feedStockKg > 0 ? `Approximately ${daysOfFeed.toFixed(0)} days of feed on hand.` : "Feed stock not tracked in inventory.",
      recommendation: "Maintain at least 7 days of feed supply.",
      timestamp: today, value: feedStockKg > 0 ? `${daysOfFeed.toFixed(0)} days` : "—", threshold: "7 days",
    });
  }

  // ── 9. EXPENSES & PROFITABILITY ─────────────────────────────────
  const expenses = transactions.filter((tr) => tr.businessId === (transactions[0]?.businessId) && tr.type === "EXPENSE");
  const income = transactions.filter((tr) => tr.businessId === (transactions[0]?.businessId) && tr.type === "INCOME");
  const expensesWeek = expenses.filter((tr) => tr.date >= lastWeek).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const incomeWeek = income.filter((tr) => tr.date >= lastWeek).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const expensesMonth = expenses.filter((tr) => tr.date >= lastMonth).reduce((s, t) => s + (t.amountGhs || 0), 0);
  const incomeMonth = income.filter((tr) => tr.date >= lastMonth).reduce((s, t) => s + (t.amountGhs || 0), 0);

  const profitMonth = incomeMonth - expensesMonth;
  const profitRate = expensesMonth > 0 ? (profitMonth / expensesMonth) * 100 : 0;

  if (profitMonth < 0) {
    alerts.push({
      id: "profit-negative", level: "critical", category: "Finance",
      title: "Negative Profit",
      message: `Monthly net profit is negative at ${formatMoney(profitMonth, data.currentCurrency as any)}.`,
      recommendation: "Review expenses — prioritize feed costs (60-70% of costs) and sales prices. Consider raising egg/broiler prices or negotiating better feed supplier rates.",
      timestamp: today,
      value: formatMoney(profitMonth, data.currentCurrency as any),
      threshold: "positive",
    });
  } else if (profitRate < 15) {
    alerts.push({
      id: "profit-low-margin", level: "warning", category: "Finance",
      title: "Thin Profit Margin",
      message: `Monthly profit margin is only ${profitRate.toFixed(1)}% of expenses.`,
      recommendation: "Look for cost savings (feed, labour) and revenue growth opportunities to improve margins above 15%.",
      timestamp: today,
      value: `${profitRate.toFixed(1)}%`, threshold: "15%",
    });
  } else {
    alerts.push({
      id: "profit-normal", level: "normal", category: "Finance",
      title: "Healthy Profitability",
      message: `Monthly profit of ${formatMoney(profitMonth, data.currentCurrency as any)} (${profitRate.toFixed(1)}% margin).`,
      recommendation: "Consider reinvesting profits into infrastructure or feed purchasing for better rates.",
      timestamp: today,
      value: `${profitRate.toFixed(1)}%`, threshold: "> 15%",
    });
  }

  metrics.push({
    label: "Monthly Profit", current: formatMoney(profitMonth, data.currentCurrency as any), previous: `Exp: ${formatMoney(expensesMonth, data.currentCurrency as any)}`,
    changePct: 0, status: profitMonth >= 0 ? "UP" : "DOWN", trend: profitMonth >= 0 ? "improving" : "declining",
    color: profitMonth >= 0 ? "green" : "red",
  });

  // ── 10. VACCINATION NEXT DUE ────────────────────────────────────
  const upcomingVaccinations = healthRecords.filter((h) => h.nextDueDate && h.nextDueDate >= today && h.nextDueDate <= daysAgo(-7));
  if (upcomingVaccinations.length > 0) {
    alerts.push({
      id: "vaccine-due", level: "warning", category: "Vaccination",
      title: "Vaccination(s) Due Soon",
      message: `${upcomingVaccinations.length} vaccination(s) due within 7 days: ${upcomingVaccinations.map((v) => v.vaccineOrDrug).join(", ")}.`,
      recommendation: "Schedule vaccination and ensure vaccine stock is available.",
      timestamp: today, value: `${upcomingVaccinations.length} due`, threshold: "0",
    });
  }

  // ── Compose health score ──
  const criticalCount = alerts.filter((a) => a.level === "critical").length;
  const warningCount = alerts.filter((a) => a.level === "warning").length;
  const healthScore = Math.max(0, Math.min(100, 100 - criticalCount * 20 - warningCount * 5));
  const statusColor: "green" | "yellow" | "red" =
    criticalCount > 0 ? "red" : warningCount > 0 ? "yellow" : "green";

  const genericAlerts = alerts.filter((a) =>
    ["Mortality", "Feed Intake", "Water", "Egg Production", "Health", "Daily Routine"].includes(a.category)
  );
  const otherAlerts = alerts.filter((a) => !genericAlerts.includes(a));

  return { alerts: [...genericAlerts, ...otherAlerts], metrics, healthScore, statusColor };
}

export const ALERT_STYLES: Record<AlertLevel, string> = {
  critical: "bg-rose-500/15 border-rose-500/40 text-rose-200",
  warning: "bg-amber-500/15 border-amber-500/40 text-amber-200",
  normal: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200",
};

export const METRIC_COLORS: Record<string, string> = {
  green: "text-emerald-400 border-emerald-500/40",
  yellow: "text-amber-400 border-amber-500/40",
  red: "text-rose-400 border-rose-500/40",
};
