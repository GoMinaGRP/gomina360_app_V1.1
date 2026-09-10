"use client";

import React, { useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  Egg,
  Boxes,
  Fish,
  Building2,
  Utensils,
  Cpu,
  Droplets,
  Plus,
  TrendingUp,
  DollarSign,
  AlertCircle,
  CheckCircle,
  Activity,
  Award,
  BarChart2,
  Calendar,
  WifiOff,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { addToOfflineQueue } from "@/lib/offlineSync";
import DailyChecklistPanel from "./DailyChecklistPanel";
import FinancialReportSection from "./FinancialReportSection";

interface SpecializedBusinessViewProps {
  businessCode: string;
  businessInfo: any;
  businessMetrics: any;
  specializedLogs: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshLogs: () => void;
  currentUser?: any;
  employees?: any[];
  transactions?: any[];
  inventory?: any[];
  customers?: any[];
  /** LivestockModule hosts the Financial Report in its own FINANCE tab;
   *  when true, the inline report at the bottom of this ops view is hidden. */
  hideFinanceReport?: boolean;
}

export default function SpecializedBusinessView({
  businessCode,
  businessInfo,
  businessMetrics,
  specializedLogs,
  currentCurrency,
  isOnline,
  onRefreshLogs,
  currentUser,
  employees,
  transactions,
  inventory,
  customers,
  hideFinanceReport = false,
}: SpecializedBusinessViewProps) {
  const [showLogModal, setShowLogModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form states for all 7 businesses — start EMPTY / neutral (owner directive:
  // new & reset units must never pre-fill sample or demo values).
  const [batchNumber, setBatchNumber] = useState("");
  const [birdType, setBirdType] = useState("LAYERS");
  const [totalBirds, setTotalBirds] = useState(0);
  const [dailyEggsTrays, setDailyEggsTrays] = useState(0);
  const [feedConsumedKg, setFeedConsumedKg] = useState(0);
  const [mortalityCount, setMortalityCount] = useState(0);
  const [healthStatus, setHealthStatus] = useState("HEALTHY");

  // Block Factory form state
  const [batchId, setBatchId] = useState("");
  const [blockType, setBlockType] = useState("6-INCH-SOLID");
  const [bagsCementUsed, setBagsCementUsed] = useState(0);
  const [blocksMolded, setBlocksMolded] = useState(0);
  const [blocksBroken, setBlocksBroken] = useState(0);
  const [qualityGrade, setQualityGrade] = useState("GRADE_A_STANDARD");

  // Aquaculture form state
  const [pondId, setPondId] = useState("");
  const [species, setSpecies] = useState("VOLTA_TILAPIA");
  const [stockCount, setStockCount] = useState(0);
  const [averageWeightGrams, setAverageWeightGrams] = useState(0);
  const [phLevel, setPhLevel] = useState(0);
  const [dissolvedOxygen, setDissolvedOxygen] = useState(0);
  const [fcr, setFcr] = useState(0);

  // Livestock form state
  const [tagNumber, setTagNumber] = useState("");
  const [animalType, setAnimalType] = useState("CATTLE");
  const [breed, setBreed] = useState("");
  const [weightKg, setWeightKg] = useState(0);
  const [vaccinationStatus, setVaccinationStatus] = useState("UP_TO_DATE");
  const [pregnantStatus, setPregnantStatus] = useState(false);

  // Restaurant form state
  const [totalOrders, setTotalOrders] = useState(0);
  const [mostPopularDish, setMostPopularDish] = useState("");
  const [foodCostPercent, setFoodCostPercent] = useState(0);
  const [wastePercent, setWastePercent] = useState(0);
  const [momoReceiptsGhs, setMomoReceiptsGhs] = useState(0);
  const [cashReceiptsGhs, setCashReceiptsGhs] = useState(0);

  // Electronics form state
  const [serialNumber, setSerialNumber] = useState("");
  const [productName, setProductName] = useState("");
  const [brand, setBrand] = useState("");
  const [warrantyMonths, setWarrantyMonths] = useState(0);
  const [inStock, setInStock] = useState(true);
  const [retailPriceGhs, setRetailPriceGhs] = useState(0);

  // Car Wash form state
  const [vehiclesWashed, setVehiclesWashed] = useState(0);
  const [chemicalUsedLiters, setChemicalUsedLiters] = useState(0);
  const [totalRevenueGhs, setTotalRevenueGhs] = useState(0);
  const [waterPressurePsi, setWaterPressurePsi] = useState(0);

  const bizCategory = businessInfo?.category || "Enterprise Unit";
  const upperCode = (businessCode || "").toUpperCase();

  const handleAddLog = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    let payload: any = {};
    if (upperCode.startsWith("POULTRY")) {
      payload = {
        batchNumber,
        birdType,
        totalBirds,
        dailyEggsTrays,
        feedConsumedKg,
        mortalityCount,
        healthStatus,
      };
    } else if (upperCode.startsWith("BLOCK")) {
      payload = {
        batchId,
        blockType,
        bagsCementUsed,
        blocksMolded,
        blocksBroken,
        qualityGrade,
      };
    } else if (upperCode.startsWith("AQUA")) {
      payload = {
        pondId,
        species,
        stockCount,
        averageWeightGrams,
        phLevel,
        dissolvedOxygen,
        fcr,
      };
    } else if (upperCode.startsWith("LIVESTOCK")) {
      payload = {
        tagNumber,
        animalType,
        breed,
        weightKg,
        vaccinationStatus,
        pregnantStatus,
      };
    } else if (upperCode.startsWith("FOOD")) {
      payload = {
        totalOrders,
        mostPopularDish,
        foodCostPercent,
        wastePercent,
        momoReceiptsGhs,
        cashReceiptsGhs,
      };
    } else if (upperCode.startsWith("TECH")) {
      payload = {
        serialNumber,
        productName,
        brand,
        warrantyMonths,
        inStock,
        retailPriceGhs,
      };
    } else if (upperCode.startsWith("WASH")) {
      payload = {
        vehiclesWashed,
        chemicalUsedLiters,
        totalRevenueGhs,
        waterPressurePsi,
      };
    }

    if (!isOnline) {
      // Queue offline for rural farm/branch environments
      addToOfflineQueue("SPECIALIZED_LOG", payload, upperCode);
      setIsSubmitting(false);
      setShowLogModal(false);
      onRefreshLogs();
      return;
    }

    try {
      const res = await fetch(`/api/logs/${upperCode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        onRefreshLogs();
        setShowLogModal(false);
      }
    } catch (err) {
      console.error("Error adding log:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderIcon = () => {
    if (upperCode.startsWith("POULTRY")) return <Egg className="w-6 h-6 text-emerald-400" />;
    if (upperCode.startsWith("BLOCK")) return <Boxes className="w-6 h-6 text-amber-400" />;
    if (upperCode.startsWith("AQUA")) return <Fish className="w-6 h-6 text-cyan-400" />;
    if (upperCode.startsWith("LIVESTOCK")) return <Building2 className="w-6 h-6 text-teal-400" />;
    if (upperCode.startsWith("FOOD")) return <Utensils className="w-6 h-6 text-rose-400" />;
    if (upperCode.startsWith("TECH")) return <Cpu className="w-6 h-6 text-purple-400" />;
    if (upperCode.startsWith("WASH")) return <Droplets className="w-6 h-6 text-blue-400" />;
    return <Activity className="w-6 h-6 text-emerald-400" />;
  };

  // Calculate specialized KPIs for this business from its logs.
  // NOTE (owner directive): a clean / reset unit must show honest, zero-based
  // metrics and empty states — never sample or demo numbers. Every card below
  // is derived purely from the unit's own recorded logs ("—" when none exist).
  const getSpecializedKpiCards = () => {
    const logs = specializedLogs || [];
    const sum = (key: string) => logs.reduce((a: number, r: any) => a + (Number(r[key]) || 0), 0);
    const avg = (key: string, digits = 1) =>
      logs.length > 0 ? (sum(key) / logs.length).toFixed(digits) : "—";

    if (upperCode.startsWith("POULTRY")) {
      const totalTrays = sum("dailyEggsTrays");
      const totalBirds = sum("totalBirds");
      const mortalities = sum("mortalityCount");
      const mortalityRate = totalBirds > 0 ? ((mortalities / totalBirds) * 100).toFixed(2) : "—";
      return [
        { label: "Total Eggs Harvested", value: `${totalTrays.toLocaleString()} Trays`, subtitle: "From recorded operations" },
        { label: "Avg Feed Consumed/Day", value: avg("feedConsumedKg") === "—" ? "—" : `${avg("feedConsumedKg")} Kg`, subtitle: "Recorded feed logs" },
        { label: "Mortality Rate", value: mortalityRate === "—" ? "—" : `${mortalityRate}%`, subtitle: "From recorded operations" },
        { label: "Total Birds Placed", value: totalBirds.toLocaleString(), subtitle: "Across recorded batches" },
      ];
    }

    if (upperCode.startsWith("BLOCK")) {
      const totalBlocks = sum("blocksMolded");
      const totalBroken = sum("blocksBroken");
      const breakRate = totalBlocks > 0 ? ((totalBroken / totalBlocks) * 100).toFixed(2) : "—";
      return [
        { label: "Blocks Molded", value: `${totalBlocks.toLocaleString()} Units`, subtitle: "From recorded production" },
        { label: "Breakage Rate", value: breakRate === "—" ? "—" : `${breakRate}%`, subtitle: "From recorded production" },
        { label: "Cement Bags Used", value: `${sum("bagsCementUsed").toLocaleString()} Bags`, subtitle: "From recorded production" },
        { label: "Batches Logged", value: String(logs.length), subtitle: "Production entries this unit" },
      ];
    }

    if (upperCode.startsWith("AQUA")) {
      return [
        { label: "Avg Dissolved O₂", value: avg("dissolvedOxygen") === "—" ? "—" : `${avg("dissolvedOxygen")} mg/L`, subtitle: "Recorded water logs" },
        { label: "Avg Water pH", value: avg("phLevel"), subtitle: "Recorded water logs" },
        { label: "Avg FCR", value: avg("fcr", 2), subtitle: "Recorded feed conversion" },
        { label: "Active Stock Count", value: sum("stockCount").toLocaleString(), subtitle: "Across recorded cages/ponds" },
      ];
    }

    if (upperCode.startsWith("LIVESTOCK")) {
      const herd = logs.length;
      const vaccinated = logs.filter((r: any) => String(r.vaccinationStatus || "").toUpperCase() === "UP_TO_DATE").length;
      const breeding = logs.filter((r: any) => !!r.pregnantStatus).length;
      const avgWeight = avg("weightKg");
      return [
        { label: "Total Tagged Herd", value: `${herd.toLocaleString()} Animals`, subtitle: "Recorded animals" },
        { label: "Vaccination Compliance", value: herd > 0 ? `${Math.round((vaccinated / herd) * 100)}%` : "—", subtitle: herd > 0 ? `${vaccinated} of ${herd} up-to-date` : "No records yet" },
        { label: "Avg Animal Weight", value: avgWeight === "—" ? "—" : `${avgWeight} Kg`, subtitle: "Recorded weights" },
        { label: "Pregnant / Breeding", value: `${breeding} Active`, subtitle: "Recorded breeding status" },
      ];
    }

    if (upperCode.startsWith("FOOD")) {
      const totalOrders = sum("totalOrders");
      const momo = sum("momoReceiptsGhs");
      const cash = sum("cashReceiptsGhs");
      const total = momo + cash;
      const momoShare = total > 0 ? `${Math.round((momo / total) * 100)}%` : "—";
      return [
        { label: "Total Shift Orders", value: `${totalOrders.toLocaleString()} Orders`, subtitle: "From recorded shifts" },
        { label: "Avg Food Cost %", value: avg("foodCostPercent"), subtitle: "Recorded shifts" },
        { label: "Avg Waste %", value: avg("wastePercent"), subtitle: "Recorded shifts" },
        { label: "MoMo Share of Sales", value: momoShare, subtitle: "Recorded receipts" },
      ];
    }

    if (upperCode.startsWith("TECH")) {
      return [
        { label: "Units Logged", value: logs.length.toLocaleString(), subtitle: "Recorded items" },
        { label: "In-Stock Units", value: logs.filter((r: any) => r.inStock !== false).length.toLocaleString(), subtitle: "Recorded stock status" },
        { label: "Avg Warranty (Months)", value: avg("warrantyMonths", 0), subtitle: "Recorded warranties" },
        { label: "Recorded Sales Value", value: formatMoney(sum("retailPriceGhs"), currentCurrency), subtitle: "Recorded retail prices" },
      ];
    }

    if (upperCode.startsWith("WASH")) {
      return [
        { label: "Vehicles Serviced", value: sum("vehiclesWashed").toLocaleString(), subtitle: "From recorded shifts" },
        { label: "Avg Pressure (PSI)", value: avg("waterPressurePsi", 0), subtitle: "Recorded shifts" },
        { label: "Chemical Used", value: `${sum("chemicalUsedLiters").toLocaleString()} L`, subtitle: "Recorded shifts" },
        { label: "Total Shift Receipts", value: formatMoney(sum("totalRevenueGhs"), currentCurrency), subtitle: "Recorded revenue" },
      ];
    }

    return [
      { label: "Branch Status", value: businessInfo?.status || "ACTIVE", subtitle: "Current unit status" },
      { label: "Operations Logged", value: String(logs.length), subtitle: "This unit's logbook" },
      { label: "Q1 Revenue", value: formatMoney(businessMetrics?.revenueGhs ?? 0, currentCurrency), subtitle: "Live ledger" },
      { label: "Q1 Net Profit", value: formatMoney(businessMetrics?.netProfitGhs ?? 0, currentCurrency), subtitle: "Live ledger" },
    ];
  };

  const kpis = getSpecializedKpiCards();

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* Business Header & Overview Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            {renderIcon()}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
                {bizCategory.toUpperCase()} MODULE
              </span>
              <span className="text-xs text-slate-400">
                Code: {businessInfo?.code || upperCode}
              </span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              {businessInfo?.name || "GoMina 360 Business Unit"}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Location: {businessInfo?.branchLocation || "Ghana"} • Branch Manager:{" "}
              <strong className="text-emerald-300">
                {businessInfo?.managerName || "Assigned Manager"}
              </strong>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-right hidden lg:block mr-2">
            <div className="text-xs text-slate-400">Q1 Revenue</div>
            <div className="text-lg font-bold text-emerald-400">
              {formatMoney(businessMetrics?.revenueGhs ?? 0, currentCurrency)}
            </div>
            <div className="text-[10px] text-slate-400">
              ROI: {businessMetrics?.roiPercent ?? 0}%
            </div>
          </div>

          <AiSectionGuide
            moduleKey={upperCode.startsWith("WASH") ? "WASH" : "LIVESTOCK"}
            section="OPERATIONS"
            businessInfo={businessInfo}
            variant="header"
          />
          <button
            onClick={() => setShowLogModal(true)}
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
          >
            <Plus className="w-4 h-4" />
            <span>Log Daily Operations</span>
          </button>
        </div>
      </div>

      {/* 4 Custom Specialized Operational KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((card, idx) => (
          <div
            key={idx}
            className="bg-slate-800/90 border border-slate-700/80 p-5 rounded-xl shadow-lg"
          >
            <div className="text-xs font-semibold text-slate-400">
              {card.label}
            </div>
            <div className="text-xl font-black text-white mt-1">
              {card.value}
            </div>
            <div className="text-xs text-emerald-400 mt-1 font-medium">
              {card.subtitle}
            </div>
          </div>
        ))}
      </div>

      {/* Specialized Operational Log Table */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold text-white">
              {bizCategory} Daily Operations Logbook
            </h3>
            <p className="text-xs text-slate-400">
              Complete audit trail of specialized operational data, production batches, quality grades, and shift receipts.
            </p>
          </div>
          <div className="text-xs text-slate-400">
            Total Records: {specializedLogs.length}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
              <tr>
                {upperCode.startsWith("POULTRY") && (
                  <>
                    <th className="px-4 py-3">Batch & Bird Type</th>
                    <th className="px-4 py-3 text-right">Total Birds</th>
                    <th className="px-4 py-3 text-right">Daily Eggs (Trays)</th>
                    <th className="px-4 py-3 text-right">Feed Consumed (Kg)</th>
                    <th className="px-4 py-3 text-right">Mortality</th>
                    <th className="px-4 py-3 text-center">Health Status</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </>
                )}

                {upperCode.startsWith("BLOCK") && (
                  <>
                    <th className="px-4 py-3">Batch & Block Type</th>
                    <th className="px-4 py-3 text-right">Cement Bags Used</th>
                    <th className="px-4 py-3 text-right">Blocks Molded</th>
                    <th className="px-4 py-3 text-right">Broken Blocks</th>
                    <th className="px-4 py-3 text-center">Quality Grade</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </>
                )}

                {upperCode.startsWith("AQUA") && (
                  <>
                    <th className="px-4 py-3">Cage / Pond & Species</th>
                    <th className="px-4 py-3 text-right">Stock Count</th>
                    <th className="px-4 py-3 text-right">Avg Weight (g)</th>
                    <th className="px-4 py-3 text-right">pH Level</th>
                    <th className="px-4 py-3 text-right">Dissolved O₂ (mg/L)</th>
                    <th className="px-4 py-3 text-right">FCR</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </>
                )}

                {upperCode.startsWith("LIVESTOCK") && (
                  <>
                    <th className="px-4 py-3">Tag & Animal Type</th>
                    <th className="px-4 py-3">Breed</th>
                    <th className="px-4 py-3 text-right">Weight (Kg)</th>
                    <th className="px-4 py-3 text-center">Vaccination</th>
                    <th className="px-4 py-3 text-center">Pregnant / Breed</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </>
                )}

                {upperCode.startsWith("FOOD") && (
                  <>
                    <th className="px-4 py-3">Most Popular Dish</th>
                    <th className="px-4 py-3 text-right">Orders</th>
                    <th className="px-4 py-3 text-right">Food Cost %</th>
                    <th className="px-4 py-3 text-right">Waste %</th>
                    <th className="px-4 py-3 text-right">MoMo Receipts</th>
                    <th className="px-4 py-3 text-right">Cash Receipts</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </>
                )}

                {upperCode.startsWith("TECH") && (
                  <>
                    <th className="px-4 py-3">Product Name</th>
                    <th className="px-4 py-3">Serial Number</th>
                    <th className="px-4 py-3">Brand & Warranty</th>
                    <th className="px-4 py-3 text-center">Stock Status</th>
                    <th className="px-4 py-3 text-right">Retail Price</th>
                    <th className="px-4 py-3 text-right">Last Audited</th>
                  </>
                )}

                {upperCode.startsWith("WASH") && (
                  <>
                    <th className="px-4 py-3">Shift Date</th>
                    <th className="px-4 py-3 text-right">Vehicles Washed</th>
                    <th className="px-4 py-3 text-right">Chemical (Liters)</th>
                    <th className="px-4 py-3 text-right">Pressure (PSI)</th>
                    <th className="px-4 py-3 text-right">Total Revenue</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {specializedLogs.map((log: any, index: number) => (
                <tr key={log.id || index} className="hover:bg-slate-700/40">
                  {upperCode.startsWith("POULTRY") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        <div>{log.batchNumber}</div>
                        <div className="text-[11px] text-emerald-400 font-bold">
                          {log.birdType}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.totalBirds?.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {log.dailyEggsTrays} Trays
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.feedConsumedKg} Kg
                      </td>
                      <td className="px-4 py-3 text-right text-rose-400 font-semibold">
                        {log.mortalityCount}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                          {log.healthStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.recordedDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("BLOCK") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        <div>{log.batchId}</div>
                        <div className="text-[11px] text-amber-300">
                          {log.blockType}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.bagsCementUsed} Bags
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {log.blocksMolded?.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-rose-300">
                        {log.blocksBroken}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                          {log.qualityGrade}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.recordedDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("AQUA") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        <div>{log.pondId}</div>
                        <div className="text-[11px] text-cyan-400">
                          {log.species}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.stockCount?.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.averageWeightGrams} g
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-300">
                        {log.phLevel}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-cyan-300">
                        {log.dissolvedOxygen} mg/L
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-amber-300">
                        {log.fcr}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.recordedDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("LIVESTOCK") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        <div>{log.tagNumber}</div>
                        <div className="text-[11px] text-teal-300 font-bold">
                          {log.animalType}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-200">{log.breed}</td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {log.weightKg} Kg
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                          {log.vaccinationStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-slate-200">
                        {log.pregnantStatus ? "YES (Pregnant)" : "No"}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.recordedDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("FOOD") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        {log.mostPopularDish}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {log.totalOrders} Orders
                      </td>
                      <td className="px-4 py-3 text-right text-amber-300">
                        {log.foodCostPercent}%
                      </td>
                      <td className="px-4 py-3 text-right text-rose-300">
                        {log.wastePercent}%
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-400">
                        {formatMoney(log.momoReceiptsGhs, currentCurrency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {formatMoney(log.cashReceiptsGhs, currentCurrency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.shiftDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("TECH") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        {log.productName}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-emerald-400">
                        {log.serialNumber}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {log.brand} ({log.warrantyMonths}m)
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                          IN STOCK
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {formatMoney(log.retailPriceGhs, currentCurrency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {log.lastCheckedDate}
                      </td>
                    </>
                  )}

                  {upperCode.startsWith("WASH") && (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-100">
                        {log.shiftDate}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-300">
                        {log.vehiclesWashed} Cars
                      </td>
                      <td className="px-4 py-3 text-right text-slate-200">
                        {log.chemicalUsedLiters} L
                      </td>
                      <td className="px-4 py-3 text-right text-cyan-300">
                        {log.waterPressurePsi} PSI
                      </td>
                      <td className="px-4 py-3 text-right font-extrabold text-emerald-400">
                        {formatMoney(log.totalRevenueGhs, currentCurrency)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {specializedLogs.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      upperCode.startsWith("POULTRY") ? 7 :
                      upperCode.startsWith("BLOCK") ? 6 :
                      upperCode.startsWith("AQUA") ? 7 :
                      upperCode.startsWith("LIVESTOCK") ? 6 :
                      upperCode.startsWith("FOOD") ? 7 :
                      upperCode.startsWith("TECH") ? 6 :
                      upperCode.startsWith("WASH") ? 5 : 4
                    }
                    className="px-4 py-10 text-center text-slate-400"
                  >
                    No records yet — log the first daily operations entry to start the logbook.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ══════════ FINANCIAL REPORT — complete, live-linked ══════════ */}
      {!hideFinanceReport && (
        <FinancialReportSection
          mode="business"
          businessInfo={businessInfo}
          businessMetric={businessMetrics}
          transactions={transactions || []}
          inventory={inventory || []}
          customers={customers || []}
          currentCurrency={currentCurrency}
          accent="orange"
          testid="fin-report-livestock"
          aiModuleKey="LIVESTOCK"
          opsLinks={[
            {
              label: "Operations logged",
              value: String(specializedLogs.length),
              note: "Daily herd/milking/grazing log entries for this unit",
              tone: "amber",
            },
          ]}
        />
      )}

      {/* ══════════ DAILY OPERATIONS CHECKLIST (unified) ══════════ */}
      <DailyChecklistPanel
        businessId={businessInfo?.id}
        branchCode={businessInfo?.code}
        businessName={businessInfo?.name}
        employees={employees || []}
        currentUser={currentUser}
        accent="cyan"
        onChanged={onRefreshLogs}
      />

      {/* Modal to log specialized operational data */}
      {showLogModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                {renderIcon()}
                <h3 className="text-lg font-bold text-white">
                  Log {bizCategory} Operations
                </h3>
              </div>
              {!isOnline && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-xs font-bold border border-amber-500/30">
                  <WifiOff className="w-3 h-3" />
                  <span>Offline Queue</span>
                </span>
              )}
            </div>

            <form onSubmit={handleAddLog} className="space-y-4">
              {upperCode.startsWith("POULTRY") && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Batch Number
                      </label>
                      <input
                        type="text"
                        value={batchNumber}
                        onChange={(e) => setBatchNumber(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Bird Type
                      </label>
                      <select
                        value={birdType}
                        onChange={(e) => setBirdType(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="LAYERS">LAYERS (Egg Production)</option>
                        <option value="BROILERS">BROILERS (Meat)</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Daily Egg Trays
                      </label>
                      <input
                        type="number"
                        value={dailyEggsTrays}
                        onChange={(e) => setDailyEggsTrays(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Feed Consumed (Kg)
                      </label>
                      <input
                        type="number"
                        value={feedConsumedKg}
                        onChange={(e) => setFeedConsumedKg(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("BLOCK") && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Block Type
                      </label>
                      <select
                        value={blockType}
                        onChange={(e) => setBlockType(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="6-INCH-SOLID">6-Inch Solid</option>
                        <option value="6-INCH-HOLLOW">6-Inch Hollow</option>
                        <option value="PAVING-BRICKS">Paving Bricks</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Cement Bags Used
                      </label>
                      <input
                        type="number"
                        value={bagsCementUsed}
                        onChange={(e) => setBagsCementUsed(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Blocks Molded
                      </label>
                      <input
                        type="number"
                        value={blocksMolded}
                        onChange={(e) => setBlocksMolded(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Broken Blocks
                      </label>
                      <input
                        type="number"
                        value={blocksBroken}
                        onChange={(e) => setBlocksBroken(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("AQUA") && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Cage / Pond ID
                      </label>
                      <input
                        type="text"
                        value={pondId}
                        onChange={(e) => setPondId(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Species
                      </label>
                      <select
                        value={species}
                        onChange={(e) => setSpecies(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="VOLTA_TILAPIA">Volta Tilapia</option>
                        <option value="AFRICAN_CATFISH">African Catfish</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Dissolved O₂ (mg/L)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        value={dissolvedOxygen}
                        onChange={(e) => setDissolvedOxygen(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Feed Conversion (FCR)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={fcr}
                        onChange={(e) => setFcr(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("LIVESTOCK") && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Tag Number
                      </label>
                      <input
                        type="text"
                        value={tagNumber}
                        onChange={(e) => setTagNumber(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Animal Type
                      </label>
                      <select
                        value={animalType}
                        onChange={(e) => setAnimalType(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="CATTLE">Cattle (Sanga)</option>
                        <option value="GOAT">Goat</option>
                        <option value="SHEEP">Sheep</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("FOOD") && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Most Popular Dish Today
                    </label>
                    <input
                      type="text"
                      value={mostPopularDish}
                      onChange={(e) => setMostPopularDish(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        MoMo Receipts (GH₵)
                      </label>
                      <input
                        type="number"
                        value={momoReceiptsGhs}
                        onChange={(e) => setMomoReceiptsGhs(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Cash Receipts (GH₵)
                      </label>
                      <input
                        type="number"
                        value={cashReceiptsGhs}
                        onChange={(e) => setCashReceiptsGhs(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("TECH") && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Product Name
                    </label>
                    <input
                      type="text"
                      value={productName}
                      onChange={(e) => setProductName(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Serial / IMEI Number
                      </label>
                      <input
                        type="text"
                        value={serialNumber}
                        onChange={(e) => setSerialNumber(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Retail Price (GH₵)
                      </label>
                      <input
                        type="number"
                        value={retailPriceGhs}
                        onChange={(e) => setRetailPriceGhs(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              {upperCode.startsWith("WASH") && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Vehicles Washed
                      </label>
                      <input
                        type="number"
                        value={vehiclesWashed}
                        onChange={(e) => setVehiclesWashed(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Daily Revenue (GH₵)
                      </label>
                      <input
                        type="number"
                        value={totalRevenueGhs}
                        onChange={(e) => setTotalRevenueGhs(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowLogModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isSubmitting
                    ? "Saving..."
                    : isOnline
                    ? "Submit to Database"
                    : "Save to Offline Queue"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
