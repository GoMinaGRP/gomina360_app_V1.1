"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, X } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Display-only: shows who is changing their password. */
  currentUser: any;
}

/**
 * Self-service "Change Password" dialog, opened from the account menu.
 * Works for every signed-in role (OWNER, managers, workers): the server
 * always applies the change to the SESSION user, so this dialog can never
 * modify another person's account. Cross-user password resets remain an
 * OWNER power inside Users & Access.
 */
export default function ChangePasswordModal({ isOpen, onClose, currentUser }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Fresh, clean form every time the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowCurrent(false);
      setShowNew(false);
      setShowConfirm(false);
      setBusy(false);
      setError("");
      setDone(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const fieldClass =
    "w-full rounded-lg bg-slate-800 border border-slate-700 focus:border-emerald-500 focus:outline-none px-3 py-2 pr-10 text-sm text-slate-100 placeholder-slate-500 transition";

  const renderField = (
    label: string,
    testId: string,
    value: string,
    setValue: (v: string) => void,
    show: boolean,
    setShow: (v: boolean) => void,
    autoComplete: string,
    hint?: string
  ) => (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <span className="relative block">
        <input
          type={show ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          data-testid={testId}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError("");
          }}
          className={fieldClass}
          placeholder={label}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-500 hover:text-slate-300 transition"
          title={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </span>
      {hint && <span className="block text-[10px] text-slate-500">{hint}</span>}
    </label>
  );

  const submit = async () => {
    // Instant client-side checks (the server re-validates everything).
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("All three fields are required.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters long.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match. Re-type the confirmation.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setDone(true);
      } else {
        setError(data?.error || "Could not change the password. Please try again.");
      }
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl"
        data-testid="change-password-modal"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Change Password</h2>
              <p className="text-[11px] text-slate-400">
                {currentUser?.name || "Your account"}
                {currentUser?.role ? ` · ${currentUser.role}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            data-testid="cp-close"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          /* Success state: the new password is already live. */
          <div className="px-5 py-8 flex flex-col items-center text-center space-y-3" data-testid="cp-success">
            <CheckCircle2 className="w-12 h-12 text-emerald-400" />
            <h3 className="text-lg font-bold text-white">Password updated</h3>
            <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
              Your new password takes effect immediately — use it the next time
              you sign in. Any other devices that were signed in to this
              account have been signed out.
            </p>
            <button
              onClick={onClose}
              data-testid="cp-done"
              className="mt-2 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition"
            >
              Done
            </button>
          </div>
        ) : (
          <form
            className="px-5 py-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) submit();
            }}
          >
            <div className="flex items-start space-x-2 rounded-lg bg-slate-800/60 border border-slate-700/70 px-3 py-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-slate-400 leading-snug">
                This changes the password for <span className="text-slate-200 font-semibold">your own account only</span>.
                Resetting someone else&apos;s password requires the OWNER role (Users &amp; Access console).
              </p>
            </div>

            {renderField("Current password", "cp-current", currentPassword, setCurrentPassword, showCurrent, setShowCurrent, "current-password")}
            {renderField("New password", "cp-new", newPassword, setNewPassword, showNew, setShowNew, "new-password", "At least 8 characters, different from your current password.")}
            {renderField("Confirm new password", "cp-confirm", confirmPassword, setConfirmPassword, showConfirm, setShowConfirm, "new-password")}

            {error && (
              <div
                data-testid="cp-error"
                className="rounded-lg bg-rose-500/10 border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-end space-x-2 pt-1 pb-1">
              <button
                type="button"
                onClick={onClose}
                data-testid="cp-cancel"
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                data-testid="cp-submit"
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-bold shadow-md transition flex items-center space-x-2"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{busy ? "Saving…" : "Save new password"}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
