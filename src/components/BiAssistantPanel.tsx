"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  BrainCircuit,
  FileStack,
  ListTodo,
  Package,
  Send,
  ShoppingCart,
  Sparkles,
  Truck,
} from "lucide-react";

/**
 * Unified BI Assistant (R5) — one place to ask and to see:
 *  U2: deterministic Q&A over real data (finance, customers, stock, credit,
 *      budgets, forecast, pending actions) with suggestion chips.
 *  U1: the cross-module operating picture (feed), most urgent first.
 * Executives only (OWNER / GM / BM) — enforced server-side.
 */
const MODULE_META: Record<string, { icon: any; label: string; color: string }> = {
  FINANCE: { icon: BadgeDollarSign, label: "Finance", color: "text-emerald-300" },
  STOCK: { icon: Package, label: "Stock", color: "text-amber-300" },
  CREDIT: { icon: Truck, label: "Credit", color: "text-rose-300" },
  ORDERS: { icon: ShoppingCart, label: "Orders", color: "text-cyan-300" },
  APPROVALS: { icon: ListTodo, label: "Approvals", color: "text-violet-300" },
  DOCUMENTS: { icon: FileStack, label: "Documents", color: "text-teal-300" },
  TASKS: { icon: ListTodo, label: "Tasks", color: "text-blue-300" },
};

const SEVERITY_STYLE: Record<string, string> = {
  URGENT: "border-rose-500/40 bg-rose-500/5",
  WARN: "border-amber-500/40 bg-amber-500/5",
  INFO: "border-slate-700/70 bg-slate-800/70",
};

const SUGGESTIONS = [
  "How is this month's finance?",
  "Who are my top customers?",
  "What's low in stock?",
  "What credit is overdue?",
  "Am I over budget?",
  "Show pending approvals",
];

export default function BiAssistantPanel() {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [feed, setFeed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", { credentials: "include" });
      const d = await res.json();
      if (d?.success) {
        setFeed(d.feed || []);
        setError("");
      } else setError(d?.error || "Could not load the assistant feed.");
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  const ask = async (q?: string) => {
    const text = String(q ?? question).trim();
    if (!text || asking) return;
    setAsking(true);
    setError("");
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ question: text }),
      });
      const d = await res.json();
      if (d?.success) {
        setHistory((h) => [...h.slice(-9), { question: text, answer: d.answer, intent: d.intent, suggestions: d.suggestions, data: d.data }]);
        setQuestion("");
        setTimeout(() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
      } else setError(d?.error || "The assistant could not answer that.");
    } catch {
      setError("Network error.");
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="bi-root">
      {/* Header + ask box */}
      <div className="bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl space-y-3">
        <div>
          <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-cyan-400" /> BI Assistant
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Ask anything about your money, customers, stock, credit, budgets or pending actions — every answer is computed
            from your live data, never invented.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
            placeholder="e.g. How is this month's finance? What credit is overdue?"
            className="flex-1 px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500/60"
            data-testid="bi-input"
          />
          <button onClick={() => ask()} disabled={asking || !question.trim()} className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50" data-testid="bi-ask">
            <Send className="w-3.5 h-3.5" /> {asking ? "Thinking…" : "Ask"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={asking} className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700 text-[11px] text-slate-300 hover:text-white hover:border-cyan-500/50 disabled:opacity-50" data-testid="bi-suggestion">
              {s}
            </button>
          ))}
        </div>
        {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2" data-testid="bi-error">{error}</p>}
      </div>

      {/* Q&A history */}
      {history.length > 0 && (
        <div className="space-y-3" data-testid="bi-history">
          {[...history].reverse().map((h, i) => (
            <div key={i} className="bg-slate-800/80 border border-slate-700/70 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-900/70 border-b border-slate-700/60 flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <p className="text-xs font-bold text-slate-200 truncate">{h.question}</p>
                <span className="ml-auto text-[9px] font-mono text-slate-500 shrink-0">{h.intent}</span>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-slate-100 whitespace-pre-wrap leading-relaxed" data-testid="bi-answer">{h.answer}</p>
                {h.suggestions?.length ? (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {h.suggestions.slice(0, 4).map((s: string) => (
                      <button key={s} onClick={() => ask(s)} disabled={asking} className="px-2 py-0.5 rounded-full bg-slate-900/80 border border-slate-700 text-[10px] text-slate-400 hover:text-white">
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* U1 — unified feed */}
      <div ref={feedRef}>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-extrabold text-white flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Your business at a glance</h4>
          <span className="text-[10px] text-slate-500">{feed.length} signal{feed.length === 1 ? "" : "s"} · urgent first</span>
        </div>
        <div className="space-y-2" data-testid="bi-feed">
          {feed.map((item, i) => {
            const meta = MODULE_META[item.module] || MODULE_META.FINANCE;
            const Icon = meta.icon;
            return (
              <div key={i} className={`border rounded-xl px-4 py-3 ${SEVERITY_STYLE[item.severity] || SEVERITY_STYLE.INFO}`} data-testid={`bi-feed-${i}`}>
                <div className="flex items-start gap-2.5">
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.color}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white">{item.title}</p>
                    {item.detail && <p className="text-[11px] text-slate-400 mt-0.5">{item.detail}</p>}
                  </div>
                  <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-900/70 text-slate-400 shrink-0">{meta.label}</span>
                </div>
              </div>
            );
          })}
          {loading && <p className="text-xs text-slate-500 px-1">Loading your operating picture…</p>}
          {!loading && feed.length === 0 && <p className="text-xs text-slate-500 px-1">No signals yet — data will appear as your businesses record activity.</p>}
        </div>
      </div>
    </div>
  );
}
