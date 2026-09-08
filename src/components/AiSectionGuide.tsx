"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  X,
  Send,
  ChevronDown,
  Lightbulb,
  CircleHelp,
  Bot,
  User,
  Loader2,
} from "lucide-react";
import { getGuide, answerQuestion } from "@/lib/aiGuides";

interface Props {
  /** Module family: POULTRY | BLOCK | TECH | FOOD | AQUA | WASH | LIVESTOCK | GENERIC | SHARED | COMMAND_CENTER | WORKER | SALES_CENTER */
  moduleKey: string;
  /** Section/tab inside the module: DASHBOARD, FLOCKS, INVENTORY, … */
  section: string;
  businessInfo?: { name?: string; code?: string; category?: string } | null;
  /** "tabs" = compact pill for tab strips (default) · "header" = raised button for page headers */
  variant?: "tabs" | "header";
}

/**
 * GoMina AI Guide — contextual, in-section help.
 *
 * A "✦ How to Use" launcher sits inside each section (tab strip or page
 * header). Opening it never navigates away: a non-modal panel slides in on
 * the right with step-by-step tasks and a free-text Q&A box, all specific to
 * the current business type AND section.
 */
export default function AiSectionGuide({ moduleKey, section, businessInfo, variant = "tabs" }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chat, setChat] = useState<{ role: "ai" | "user"; text: string }[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const guide = useMemo(
    () => getGuide(moduleKey, section, businessInfo),
    [moduleKey, section, businessInfo?.code, businessInfo?.name]
  );

  // Fresh conversation whenever the section (or business) changes.
  useEffect(() => {
    setExpanded(0);
    setChat([
      {
        role: "ai",
        text: `Hello! I'm your GoMina AI guide. ${guide.intro} 👋\n\nTap any task below for simple numbered steps, or ask me a question about this section.`,
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, section, businessInfo?.code]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat, thinking]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || thinking) return;
    setChat((c) => [...c, { role: "user", text: trimmed }]);
    setInput("");
    setThinking(true);
    // Brief "AI is composing" beat, then the scoped answer.
    setTimeout(() => {
      setChat((c) => [...c, { role: "ai", text: answerQuestion(guide, trimmed) }]);
      setThinking(false);
    }, 450);
  };

  return (
    <>
      {/* ── Launcher ─────────────────────────────────────────── */}
      <button
        type="button"
        data-testid="ai-guide-launcher"
        data-module={moduleKey}
        data-section={section}
        onClick={() => setOpen((v) => !v)}
        title={`How to use — ${guide.title}`}
        className={
          variant === "header"
            ? `flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold shadow-lg transition border ${
                open
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-slate-800 hover:bg-slate-700 text-violet-300 border-violet-500/40"
              }`
            : `ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition border ${
                open
                  ? "bg-violet-600 border-violet-500 text-white shadow"
                  : "bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border-violet-500/30"
              }`
        }
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>How to Use</span>
      </button>

      {/* ── Slide-over panel (non-modal: the section stays usable) ── */}
      {open && (
        <div
          data-testid="ai-guide-panel"
          className="fixed right-3 sm:right-4 top-[66px] bottom-4 z-40 w-[calc(100vw-1.5rem)] sm:w-[400px] flex flex-col rounded-2xl border border-violet-500/30 bg-slate-900/98 shadow-2xl shadow-black/60 animate-[aiGuideIn_0.22s_ease-out]"
        >
          <style>{`@keyframes aiGuideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-gradient-to-r from-violet-950/80 to-slate-900 rounded-t-2xl shrink-0">
            <div className="w-9 h-9 rounded-xl bg-violet-500/20 border border-violet-500/40 flex items-center justify-center shrink-0">
              <Sparkles className="w-4.5 h-4.5 text-violet-300" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-extrabold text-white truncate">
                How to Use — {guide.title}
              </div>
              <div className="text-[10px] text-violet-300/90 truncate">
                {businessInfo?.name ? `${businessInfo.name} • ` : ""}
                {businessInfo?.category || "GoMina 360"} • step-by-step help
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
              aria-label="Close guide"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* What you can do here */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                What you can do here
              </div>
              <div className="space-y-2">
                {guide.tasks.map((t, i) => {
                  const isOpen = expanded === i;
                  return (
                    <div
                      key={i}
                      className={`rounded-xl border transition ${
                        isOpen ? "border-violet-500/40 bg-violet-500/5" : "border-slate-700/80 bg-slate-800/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : i)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
                      >
                        <span className="text-xs font-bold text-slate-100">{t.name}</span>
                        <ChevronDown
                          className={`w-4 h-4 text-violet-300 transition-transform ${isOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {isOpen && (
                        <div className="px-3 pb-3 space-y-1.5" data-testid="ai-guide-steps">
                          {t.steps.map((s, j) => (
                            <div key={j} className="flex items-start gap-2">
                              <span className="mt-0.5 w-4.5 h-4.5 min-w-[18px] rounded-full bg-violet-500/20 border border-violet-400/40 text-violet-300 text-[10px] font-bold flex items-center justify-center">
                                {j + 1}
                              </span>
                              <p className="text-xs text-slate-300 leading-relaxed">{s}</p>
                            </div>
                          ))}
                          {t.tip && (
                            <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 px-2.5 py-2">
                              <Lightbulb className="w-3.5 h-3.5 text-amber-300 mt-0.5 shrink-0" />
                              <p className="text-[11px] text-amber-200/90 leading-relaxed">{t.tip}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Chat */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                <CircleHelp className="w-3.5 h-3.5 text-violet-300" /> Ask the AI guide
              </div>

              {/* Quick question chips */}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {guide.faqs.slice(0, 3).map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => ask(f.q)}
                    className="px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-200 text-[11px] font-semibold hover:bg-violet-500/20 transition"
                  >
                    {f.q}
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-2.5 space-y-2 max-h-64 overflow-y-auto">
                {chat.map((m, i) => (
                  <div key={i} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                    <div
                      className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
                        m.role === "ai" ? "bg-violet-500/20 text-violet-300" : "bg-emerald-500/20 text-emerald-300"
                      }`}
                    >
                      {m.role === "ai" ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                    </div>
                    <div
                      data-testid={m.role === "ai" ? "ai-guide-answer" : undefined}
                      className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-line max-w-[85%] ${
                        m.role === "ai"
                          ? "bg-slate-800 text-slate-200 border border-slate-700/80"
                          : "bg-emerald-600/90 text-white"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
                {thinking && (
                  <div className="flex gap-2">
                    <div className="w-6 h-6 rounded-lg bg-violet-500/20 text-violet-300 flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <div className="rounded-xl px-3 py-2 bg-slate-800 border border-slate-700/80">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-300" />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
            </div>
          </div>

          {/* Input */}
          <div className="p-3 border-t border-slate-800 shrink-0">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask(input)}
                data-testid="ai-guide-input"
                placeholder={`Ask about ${guide.title.toLowerCase()}…`}
                className="flex-1 px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-white text-xs placeholder:text-slate-500 focus:outline-none focus:border-violet-500/60"
              />
              <button
                type="button"
                onClick={() => ask(input)}
                disabled={!input.trim() || thinking}
                className="p-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white transition disabled:opacity-40"
                aria-label="Ask"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-slate-500 text-center">
              Help for this section opens right here — you never leave the page. Esc closes.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
