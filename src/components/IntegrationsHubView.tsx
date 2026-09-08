"use client";

import React, { useState } from "react";
import {
  Share2,
  CheckCircle,
  RefreshCw,
  Video,
  Cpu,
  CreditCard,
  DollarSign,
  ShoppingCart,
  Wifi,
  ExternalLink,
  ShieldCheck,
  Eye,
  Camera,
} from "lucide-react";
import CctvCommandCenter from "./CctvCommandCenter";

interface IntegrationsHubViewProps {
  integrations: any[];
  onRefreshIntegrations: () => void;
  currentUser?: any;
  businesses?: any[];
}

export default function IntegrationsHubView({
  integrations,
  onRefreshIntegrations,
  currentUser = null,
  businesses = [],
}: IntegrationsHubViewProps) {
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [showCctvModal, setShowCctvModal] = useState(false);

  const handleAction = async (id: number, action: "SYNC_NOW" | "TOGGLE_CONNECT") => {
    setSyncingId(id);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) {
        onRefreshIntegrations();
      }
    } catch (err) {
      console.error("Error managing integration:", err);
    } finally {
      setSyncingId(null);
    }
  };

  const renderIcon = (cat: string) => {
    switch (cat) {
      case "PAYMENTS":
        return <CreditCard className="w-6 h-6 text-emerald-400" />;
      case "BANKING":
        return <DollarSign className="w-6 h-6 text-teal-400" />;
      case "ACCOUNTING":
        return <Share2 className="w-6 h-6 text-cyan-400" />;
      case "CCTV_SECURITY":
        return <Video className="w-6 h-6 text-rose-400" />;
      case "IOT_SENSORS":
        return <Cpu className="w-6 h-6 text-amber-400" />;
      case "POS_HARDWARE":
      default:
        return <ShoppingCart className="w-6 h-6 text-purple-400" />;
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center text-white font-black shadow-lg shrink-0">
            <Share2 className="w-7 h-7" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">
              FUTURE-READY INTEGRATION HUB
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              Enterprise Ecosystem Connectors
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Seamlessly link Mobile Money, Corporate Banking, Xero Accounting, CCTV Cloud Feeds, IoT Pond Sensors, and POS systems.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCctvModal(true)}
            className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-red-700 hover:from-rose-500 hover:to-red-600 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            data-testid="hub-cctv-open"
          >
            <Video className="w-4 h-4" />
            <span>CCTV Security Command Center</span>
          </button>
        </div>
      </div>

      {/* Integrations Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {integrations.map((item) => {
          const isConnected = item.status === "CONNECTED";
          const isBusy = syncingId === item.id;

          return (
            <div
              key={item.id}
              className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl flex flex-col justify-between space-y-4 hover:border-slate-600 transition"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center">
                    {renderIcon(item.category)}
                  </div>

                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase flex items-center space-x-1 ${
                      isConnected
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {isConnected && <CheckCircle className="w-3 h-3 mr-1 inline" />}
                    <span>{item.status}</span>
                  </span>
                </div>

                <div>
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    {item.category}
                  </div>
                  <h3 className="text-base font-bold text-white mt-0.5">
                    {item.name}
                  </h3>
                  <p className="text-xs text-slate-300 mt-1">
                    Provider: {item.provider}
                  </p>
                </div>

                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-700/60 text-[11px] text-slate-400 flex items-center justify-between">
                  <span>Last Sync Status:</span>
                  <span className="font-semibold text-slate-200">
                    {item.lastSync}
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-700/60 flex items-center justify-between gap-2">
                <button
                  onClick={() => handleAction(item.id, "TOGGLE_CONNECT")}
                  disabled={isBusy}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    isConnected
                      ? "bg-slate-700 hover:bg-slate-600 text-slate-200"
                      : "bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow"
                  }`}
                >
                  {isConnected ? "Disconnect" : "Connect Now"}
                </button>

                {isConnected && (
                  <button
                    onClick={() => handleAction(item.id, "SYNC_NOW")}
                    disabled={isBusy}
                    className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-xs font-bold transition"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isBusy ? "animate-spin" : ""}`}
                    />
                    <span>{isBusy ? "Syncing..." : "Sync Now"}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* CCTV Security Command — Business → Branch → Cameras registry & live monitor */}
      {showCctvModal && (
        <CctvCommandCenter
          currentUser={currentUser}
          businesses={businesses}
          onClose={() => setShowCctvModal(false)}
        />
      )}
    </div>
  );
}
