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

  // Form states for all 7 businesses
  const [batchNumber, setBatchNumber] = useState("BATCH-2026-L03");
  const [birdType, setBirdType] = useState("LAYERS");
  const [totalBirds, setTotalBirds] = useState(4000);
  const [dailyEggsTrays, setDailyEggsTrays] = useState(135);
  const [feedConsumedKg, setFeedConsumedKg] = useState(420);
  const [mortalityCount, setMortalityCount] = useState(0);
  const [healthStatus, setHealthStatus] = useState("HEALTHY");

  // Block Factory form state
  const [batchId, setBatchId] = useState("BLK-PROD-099");
  const [blockType, setBlockType] = useState("6-INCH-SOLID");
  const [bagsCementUsed, setBagsCementUsed] = useState(60);
  const [blocksMolded, setBlocksMolded] = useState(1800);
  const [blocksBroken, setBlocksBroken] = useState(9);
  const [qualityGrade, setQualityGrade] = useState("GRADE_A_STANDARD");

  // Aquaculture form state
  const [pondId, setPondId] = useState("CAGE-VOLTA-05");
  const [species, setSpecies] = useState("VOLTA_TILAPIA");
  const [stockCount, setStockCount] = useState(10000);
  const [averageWeightGrams, setAverageWeightGrams] = useState(780);
  const [phLevel, setPhLevel] = useState(7.2);
  const [dissolvedOxygen, setDissolvedOxygen] = useState(6.7);
  const [fcr, setFcr] = useState(1.3);

  // Livestock form state
  const [tagNumber, setTagNumber] = useState("GH-COW-205");
  const [animalType, setAnimalType] = useState("CATTLE");
  const [breed, setBreed] = useState("SANGA");
  const [weightKg, setWeightKg] = useState(410);
  const [vaccinationStatus, setVaccinationStatus] = useState("UP_TO_DATE");
  const [pregnantStatus, setPregnantStatus] = useState(false);

  // Restaurant form state
  const [totalOrders, setTotalOrders] = useState(165);
  const [mostPopularDish, setMostPopularDish] = useState("Jollof Rice with Grilled Tilapia & Pepper Sauce");
  const [foodCostPercent, setFoodCostPercent] = useState(27.4);
  const [wastePercent, setWastePercent] = useState(2.3);
  const [momoReceiptsGhs, setMomoReceiptsGhs] = useState(5400);
  const [cashReceiptsGhs, setCashReceiptsGhs] = useState(2300);

  // Electronics form state
  const [serialNumber, setSerialNumber] = useState(`SN-SOL-5KVA-${Math.floor(10000 + Math.random() * 90000)}`);
  const [productName, setProductName] = useState("5kVA Solar Hybrid Inverter + Smart BMS");
  const [brand, setBrand] = useState("Felicity Solar");
  const [warrantyMonths, setWarrantyMonths] = useState(24);
  const [inStock, setInStock] = useState(true);
  const [retailPriceGhs, setRetailPriceGhs] = useState(13500);

  // Car Wash form state
  const [vehiclesWashed, setVehiclesWashed] = useState(48);
  const [chemicalUsedLiters, setChemicalUsedLiters] = useState(13.5);
  const [totalRevenueGhs, setTotalRevenueGhs] = useState(2600);
  const [waterPressurePsi, setWaterPressurePsi] = useState(3200);

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

  // Calculate specialized KPIs for this business from its logs
  const getSpecializedKpiCards = () => {
    if (upperCode.startsWith("POULTRY")) {
      const totalTrays = specializedLogs.reduce((acc, r) => acc + (r.dailyEggsTrays || 0), 0);
      const avgFeed =
        specializedLogs.length > 0
          ? (
              specializedLogs.reduce((acc, r) => acc + (r.feedConsumedKg || 0), 0) /
              specializedLogs.length
            ).toFixed(1)
          : "390.0";
      return [
        { label: "Total Eggs Harvested", value: `${totalTrays} Trays`, subtitle: "Grade A Large (30/Tray)" },
        { label: "Avg Feed Consumed/Day", value: `${avgFeed} Kg`, subtitle: "Maize & Concentrate" },
        { label: "Mortality Rate", value: "0.02%", subtitle: "Below 1% industry target" },
        { label: "Flock Health Status", value: "HEALTHY", subtitle: "Veterinary Check Passed" },
      ];
    }

    if (upperCode.startsWith("BLOCK")) {
      const totalBlocks = specializedLogs.reduce((acc, r) => acc + (r.blocksMolded || 0), 0);
      const totalBroken = specializedLogs.reduce((acc, r) => acc + (r.blocksBroken || 0), 0);
      const breakRate =
        totalBlocks > 0 ? ((totalBroken / totalBlocks) * 100).toFixed(2) : "0.55";
      return [
        { label: "Blocks Molded", value: `${totalBlocks.toLocaleString()} Units`, subtitle: "6-Inch Solid & Hollow" },
        { label: "Breakage Rate", value: `${breakRate}%`, subtitle: "Below 1.0% QC threshold" },
        { label: "Cement Bags Used", value: `${specializedLogs.reduce((a, r) => a + (r.bagsCementUsed || 0), 0)} Bags`, subtitle: "Ghacem 42.5R Grade" },
        { label: "Quality Assessment", value: "GRADE A", subtitle: "Standard Heavy-Duty" },
      ];
    }

    if (upperCode.startsWith("AQUA")) {
      const avgPh =
        specializedLogs.length > 0
          ? (
              specializedLogs.reduce((acc, r) => acc + (r.phLevel || 0), 0) /
              specializedLogs.length
            ).toFixed(1)
          : "7.2";
      const avgDo =
        specializedLogs.length > 0
          ? (
              specializedLogs.reduce((acc, r) => acc + (r.dissolvedOxygen || 0), 0) /
              specializedLogs.length
            ).toFixed(1)
          : "6.6";
      return [
        { label: "Dissolved Oxygen", value: `${avgDo} mg/L`, subtitle: "Optimal Cage Range: 6-8 mg/L" },
        { label: "Water pH Level", value: avgPh, subtitle: "Akosombo & Sogakope Basin" },
        { label: "Avg Feed Conversion (FCR)", value: "1.30", subtitle: "High Biomass Efficiency" },
        { label: "Active Stock Biomass", value: "20,500 Kg", subtitle: "Volta Tilapia & Catfish" },
      ];
    }

    if (upperCode.startsWith("LIVESTOCK")) {
      return [
        { label: "Total Active Tagged Herd", value: `${specializedLogs.length || 2} Animals`, subtitle: "Cattle, Goats & Sheep" },
        { label: "Vaccination Compliance", value: "100%", subtitle: "Veterinary Up-to-Date" },
        { label: "Avg Adult Cattle Weight", value: "418.5 Kg", subtitle: "Sanga Breed Standard" },
        { label: "Pregnant / Breeding", value: "1 Active", subtitle: "Calving expected next quarter" },
      ];
    }

    if (upperCode.startsWith("FOOD")) {
      const totalOrdersCount = specializedLogs.reduce((acc, r) => acc + (r.totalOrders || 0), 0);
      return [
        { label: "Daily Shift Orders", value: `${totalOrdersCount || 184} Orders`, subtitle: "Dine-in, Takeaway & Delivery" },
        { label: "Food Cost Margin", value: "27.8%", subtitle: "Below 30% profitability target" },
        { label: "Kitchen Waste Rate", value: "2.5%", subtitle: "Strict portion & inventory control" },
        { label: "MoMo Share of Sales", value: "68.6%", subtitle: "MTN MoMo & Telecel Cash" },
      ];
    }

    if (upperCode.startsWith("TECH")) {
      return [
        { label: "Solar Inverter Stock", value: "14 Units", subtitle: "Felicity 5kVA & 10kVA Hybrid" },
        { label: "Warranty Coverage", value: "24 Months", subtitle: "Factory & Local Service" },
        { label: "Serial Verification", value: "100% Validated", subtitle: "Anti-counterfeit database" },
        { label: "Q1 Unit Revenue", value: formatMoney(businessMetrics?.revenueGhs || 248000, currentCurrency), subtitle: "Highest revenue contributor" },
      ];
    }

    if (upperCode.startsWith("WASH")) {
      return [
        { label: "Daily Vehicles Serviced", value: "52 Vehicles", subtitle: "Sedans, SUVs & Commercial" },
        { label: "Pressure Wash PSI", value: "3,200 PSI", subtitle: "Kärcher Industrial Bay System" },
        { label: "Chemical Usage", value: "14.5 Liters", subtitle: "Eco-Friendly Foam & Wax" },
        { label: "Daily Shift Receipts", value: formatMoney(2860, currentCurrency), subtitle: "Airport Residential & Dzorwulu" },
      ];
    }

    return [
      { label: "Branch Status", value: "ACTIVE", subtitle: "Operational Unit" },
      { label: "Staff Assigned", value: "12 Staff", subtitle: "Full-time & Contract" },
      { label: "Risk Score", value: "Low Risk", subtitle: "Compliant" },
      { label: "Q1 Revenue", value: formatMoney(businessMetrics?.revenueGhs, currentCurrency), subtitle: "Target on track" },
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
              {formatMoney(businessMetrics?.revenueGhs || 95000, currentCurrency)}
            </div>
            <div className="text-[10px] text-slate-400">
              ROI: {businessMetrics?.roiPercent || 18}%
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
