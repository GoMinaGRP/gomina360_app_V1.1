"use client";

import React, { useState } from "react";
import { Lock, Mail, ShieldCheck, Eye, EyeOff, AlertTriangle, PackageSearch, ShoppingCart } from "lucide-react";

/**
 * GoMina 360 secure sign-in gate. Every user logs in with their own email +
 * password; the session is an httpOnly cookie (7 days, SameSite=Lax).
 */
export default function LoginScreen({ onSuccess, notice }: { onSuccess: (user: any, sessionToken?: string) => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        onSuccess(d.user, d.sessionToken);
      } else {
        setError(d?.error || "Sign in failed. Please try again.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4" data-testid="login-screen">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-900/30 via-slate-950 to-slate-950 pointer-events-none" />
      <div className="relative w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white font-black text-2xl shadow-xl border border-emerald-400/30 mb-3">
            360
          </div>
          <h1 className="text-2xl font-black tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-yellow-300 bg-clip-text text-transparent">
            GoMina 360
          </h1>
          <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mt-1">
            Ghana Enterprise Command Center
          </p>
        </div>

        <form
          onSubmit={submit}
          className="bg-slate-900/95 border border-slate-700/80 rounded-2xl shadow-2xl p-6 space-y-4 backdrop-blur"
        >
          <div className="flex items-center gap-2 text-emerald-300 font-bold text-sm">
            <ShieldCheck className="w-4 h-4" />
            Secure Sign In
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed -mt-2">
            Sign in with your own account. You will only see the businesses and
            branches the OWNER has assigned to you.
          </p>

          {notice && (
            <div
              data-testid="login-notice"
              className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 text-amber-300 p-3 rounded-lg text-xs leading-relaxed"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div
              data-testid="login-error"
              className="flex items-start gap-2 bg-rose-500/10 border border-rose-500/40 text-rose-300 p-3 rounded-lg text-xs"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@gomina360.com"
                autoComplete="username"
                data-testid="login-email"
                className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-600 focus:border-emerald-500/60 rounded-lg text-white text-sm outline-none transition"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Password</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                data-testid="login-password"
                className="w-full pl-9 pr-10 py-2.5 bg-slate-800 border border-slate-600 focus:border-emerald-500/60 rounded-lg text-white text-sm outline-none transition"
                required
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                aria-label="Toggle password visibility"
                data-testid="login-toggle-pw"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            data-testid="login-submit"
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm shadow-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Signing in…" : "Sign In"}
          </button>

          <p className="text-[10px] text-slate-500 text-center leading-relaxed">
            Sessions expire after 7 days. Accounts lock for 15 minutes after
            {" "}5 failed attempts. Forgot your password? Ask the OWNER to reset it.
          </p>

          <div className="grid grid-cols-2 gap-1.5">
            <a
              href="/order"
              className="flex items-center justify-center gap-1.5 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-bold transition"
              data-testid="login-order-link"
            >
              <ShoppingCart className="w-4 h-4" />
              Order online
            </a>
            <a
              href="/track"
              className="flex items-center justify-center gap-1.5 py-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-bold transition"
              data-testid="login-track-link"
            >
              <PackageSearch className="w-4 h-4" />
              Track your order
            </a>
          </div>
          <p className="text-[9px] text-slate-600 text-center -mt-1">Customers: no sign-in needed for ordering & tracking</p>
        </form>
      </div>
    </div>
  );
}
