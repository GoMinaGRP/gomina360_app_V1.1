"use client";

import React, { useState } from "react";
import {
  Sparkles,
  TrendingUp,
  ShieldAlert,
  Send,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";

interface AiAdvisorViewProps {
  insights: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  onRefreshInsights: () => void;
}

export default function AiAdvisorView({
  insights,
  businesses,
  currentCurrency,
  onRefreshInsights,
}: AiAdvisorViewProps) {
  const [prompt, setPrompt] = useState("");
  const [selectedBizId, setSelectedBizId] = useState<string>("ALL");
  const [isGenerating, setIsGenerating] = useState(false);

  const samplePrompts = [
    "How can we reduce block breakage rates at the Tema factory?",
    "Evaluate Poultry maize feed cost inflation risks for Q2",
    "Should we invest GH₵ 100,000 to expand Solar Inverter stock?",
    "Optimize Volta Basin Tilapia harvest timing for Easter demand",
  ];

  const handleAskAi = async (queryText?: string) => {
    const textToUse = queryText || prompt;
    if (!textToUse.trim()) return;

    setIsGenerating(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: textToUse,
          targetBusinessId: selectedBizId === "ALL" ? null : Number(selectedBizId),
        }),
      });
      if (res.ok) {
        setPrompt("");
        onRefreshInsights();
      }
    } catch (err) {
      console.error("Error calling AI Advisor:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const getBusinessName = (id: number | null) => {
    if (!id) return "Enterprise-Wide HQ";
    const b = businesses.find((x) => x.id === id);
    return b ? b.name : "Operating Unit";
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* AI Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center text-slate-950 font-black shadow-lg shrink-0">
            <Sparkles className="w-7 h-7" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-xs font-bold border border-amber-500/30">
              GOMINA 360 AI EXECUTIVE ADVISOR
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              Strategic Decision-Support Engine
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              AI-powered analysis of risks, efficiency gains, and capital allocation across all 7 Ghanaian businesses.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-semibold border border-emerald-500/30">
            <CheckCircle2 className="w-4 h-4" />
            <span>AI Risk Radar Online</span>
          </span>
        </div>
      </div>

      {/* AI Ask Sandbox */}
      <div className="bg-slate-800/90 border border-slate-700/80 p-5 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-white">
              Ask GoMina 360 AI Advisor
            </h3>
            <p className="text-xs text-slate-400">
              Type any operational question or select an example prompt to generate actionable strategic recommendations.
            </p>
          </div>
          <div>
            <select
              value={selectedBizId}
              onChange={(e) => setSelectedBizId(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200"
            >
              <option value="ALL">Target: Enterprise-Wide</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask anything (e.g. 'How can we hedge poultry feed costs in Q2?')..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAskAi();
            }}
            className="flex-1 px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none focus:border-amber-500"
          />
          <button
            onClick={() => handleAskAi()}
            disabled={isGenerating || !prompt.trim()}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-slate-950 font-bold text-xs sm:text-sm flex items-center space-x-1.5 shadow-md transition disabled:opacity-50"
          >
            {isGenerating ? (
              <span>Analyzing...</span>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Analyze</span>
              </>
            )}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <span className="text-xs font-semibold text-slate-400 mr-1 self-center">
            Example Queries:
          </span>
          {samplePrompts.map((sample, i) => (
            <button
              key={i}
              onClick={() => handleAskAi(sample)}
              disabled={isGenerating}
              className="px-3 py-1 rounded-lg bg-slate-900/80 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 hover:text-white transition text-left"
            >
              "{sample}"
            </button>
          ))}
        </div>
      </div>

      {/* AI Recommendation Cards Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">
            Executive AI Recommendations & Risk Mitigations
          </h3>
          <span className="text-xs text-slate-400">
            {insights.length} active strategic recommendations
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {insights.map((insight) => (
            <div
              key={insight.id}
              className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl flex flex-col justify-between space-y-4 hover:border-slate-600 transition"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                      insight.impactLevel === "CRITICAL"
                        ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                        : insight.impactLevel === "HIGH"
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    }`}
                  >
                    {insight.impactLevel} IMPACT • {insight.category}
                  </span>

                  <span className="text-xs font-semibold text-slate-400">
                    {getBusinessName(insight.businessId)}
                  </span>
                </div>

                <h4 className="text-base sm:text-lg font-bold text-white">
                  {insight.title}
                </h4>

                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  {insight.recommendation}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-700/60 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-slate-400">
                    Projected Gain / Impact
                  </div>
                  <div className="text-sm font-extrabold text-emerald-400">
                    {insight.metricAffected}
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[11px] text-slate-400">
                    Estimated Value
                  </div>
                  <div className="text-sm font-black text-amber-300">
                    +{formatMoney(insight.projectedGainGhs || 20000, currentCurrency)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
