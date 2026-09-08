"use client";

import React, { useEffect, useState } from "react";
import {
  Globe,
  Wifi,
  WifiOff,
  RefreshCw,
  User,
  Shield,
  Bell,
  ChevronDown,
  Briefcase,
  CheckCircle2,
  KeyRound,
  Camera,
} from "lucide-react";
import { CurrencyCode, CURRENCIES } from "@/lib/currency";
import { synchronizeOfflineQueue, getOfflineQueue } from "@/lib/offlineSync";
import AttendanceClock from "./AttendanceClock";
import Avatar from "./Avatar";
import { useClampedDropdown } from "./nav/useClampedDropdown";

interface NavbarProps {
  currentCurrency: CurrencyCode;
  onCurrencyChange: (code: CurrencyCode) => void;
  isOnline: boolean;
  onToggleOnline: () => void;
  offlineQueueCount: number;
  onSyncComplete: () => void;
  currentUser: any;
  usersList: any[];
  onUserSelect: (user: any) => void;
  /** Secure session sign-out (replaces the old free role-switcher). */
  onLogout?: () => void;
  /** Opens the self-service "Change Password" dialog (any signed-in role). */
  onOpenChangePassword?: () => void;
  /** Opens the self-service "Profile Photo" manager (any signed-in role). */
  onOpenProfilePhoto?: () => void;
  /** Opens Manage Units → Online Ordering & service areas (OWNER / GM / BM /
   *  record managers only — the entry is hidden for everyone else). */
  onOpenOnlineOrdering?: () => void;
  /** Notification bell element (rendered before the account menu). */
  bellSlot?: React.ReactNode;
}

export default function Navbar({
  currentCurrency,
  onCurrencyChange,
  isOnline,
  onToggleOnline,
  offlineQueueCount,
  onSyncComplete,
  currentUser,
  usersList,
  onUserSelect,
  onLogout,
  onOpenChangePassword,
  onOpenProfilePhoto,
  onOpenOnlineOrdering,
  bellSlot,
}: NavbarProps) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [showCurrencyDropdown, setShowCurrencyDropdown] = useState(false);
  const [showUserDropdown, setShowUserDropdown] = useState(false);

  // Viewport-clamped dropdown positioning — the Staff/Account menu and the
  // currency menu can never render outside the screen, at any width.
  const currencyMenu = useClampedDropdown(showCurrencyDropdown, 224);
  const userMenu = useClampedDropdown(showUserDropdown, 288);

  // Close both menus on outside click / Escape (they also toggle on their
  // own buttons). rootRef wraps trigger+panel, so "inside" checks are exact.
  useEffect(() => {
    if (!showCurrencyDropdown && !showUserDropdown) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (showCurrencyDropdown && currencyMenu.rootRef.current && !currencyMenu.rootRef.current.contains(t)) {
        setShowCurrencyDropdown(false);
      }
      if (showUserDropdown && userMenu.rootRef.current && !userMenu.rootRef.current.contains(t)) {
        setShowUserDropdown(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowCurrencyDropdown(false);
        setShowUserDropdown(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showCurrencyDropdown, showUserDropdown, currencyMenu.rootRef, userMenu.rootRef]);

  const handleSync = async () => {
    setIsSyncing(true);
    await synchronizeOfflineQueue();
    setIsSyncing(false);
    onSyncComplete();
  };

  return (
    <header className="sticky top-0 z-40 bg-slate-900 border-b border-slate-800 text-white shadow-lg" data-testid="top-navbar">
      {/* flex-wrap is the hard guarantee: if the controls can ever be wider
          than the screen (tiny phones, huge zoom, long names), the row wraps
          to a second line instead of pushing the Staff/Account menu off the
          right edge, where the page's overflow-x:clip would make it
          unreachable. Brand + every control are shrink-0 so nothing is
          squashed into unreadability either. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-2 sm:px-6 py-2.5">
        {/* Left Branding — shrink-0 so the brand chip can never be squashed by the controls */}
        <div className="flex items-center space-x-2 sm:space-x-3 min-w-0 shrink-0">
          <div className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white font-black text-[10px] sm:text-lg shadow-md border border-emerald-400/30 shrink-0 tracking-tight">
            360
          </div>
          <div className="hidden sm:block min-w-0">
            <div className="flex items-center space-x-2">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight whitespace-nowrap bg-gradient-to-r from-emerald-400 via-teal-200 to-yellow-300 bg-clip-text text-transparent">
                GoMina 360
              </h1>
              {/* Decorative tagline — only on wide screens where it fits
                  without forcing the controls onto a second line. */}
              <span className="hidden xl:inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800 whitespace-nowrap">
                Ghana Enterprise Command Center
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden xl:block">
              All-In-One Enterprise Management & Decision-Support System
            </p>
          </div>
        </div>

        {/* Right Controls — always visible: wraps under the brand as a whole
            group rather than ever overflowing horizontally. */}
        <div className="flex flex-nowrap items-center gap-1 sm:gap-2 lg:gap-3 shrink-0 ml-auto" data-testid="navbar-controls">
          {/* Currency Switcher — icon+symbol on compact screens, full at lg */}
          <div className="relative shrink-0" ref={currencyMenu.rootRef}>
            <button
              onClick={() => setShowCurrencyDropdown(!showCurrencyDropdown)}
              className="flex items-center space-x-1.5 px-1.5 sm:px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs sm:text-sm font-medium transition"
              title="Switch currency for future international expansion"
              data-testid="currency-switcher"
            >
              <Globe className="w-4 h-4 text-emerald-400 hidden lg:block" />
              <span>{CURRENCIES[currentCurrency].symbol}</span>
              <span className="hidden lg:inline">{currentCurrency}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 hidden lg:block" />
            </button>

            {showCurrencyDropdown && (
              <div
                className="rounded-xl bg-slate-800 border border-slate-700 shadow-2xl py-2 z-50 overflow-y-auto"
                style={currencyMenu.panelStyle}
                data-testid="currency-menu"
              >
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-700/60 mb-1">
                  Operating Currency
                </div>
                {(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => {
                  const curr = CURRENCIES[code];
                  return (
                    <button
                      key={code}
                      onClick={() => {
                        onCurrencyChange(code);
                        setShowCurrencyDropdown(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-slate-700/70 transition ${
                        currentCurrency === code
                          ? "bg-emerald-500/15 text-emerald-400 font-semibold"
                          : "text-slate-200"
                      }`}
                    >
                      <div>
                        <span className="font-bold mr-2">{curr.symbol}</span>
                        <span>{curr.name}</span>
                      </div>
                      {currentCurrency === code && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Staff Attendance — Clock In / Out with GPS */}
          <AttendanceClock currentUser={currentUser} />

          {/* Online / Offline Mode Toggle & Sync Button */}
          <div className="flex items-center space-x-1 shrink-0 bg-slate-800/80 border border-slate-700 rounded-lg px-1 sm:px-2.5 py-1.5">
            <button
              onClick={onToggleOnline}
              className={`flex items-center space-x-1.5 text-xs font-medium px-2 py-0.5 rounded-md transition ${
                isOnline
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
              }`}
              title="Toggle online / offline rural data collection simulation"
            >
              {isOnline ? (
                <>
                  <Wifi className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">Online</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">Offline Mode</span>
                </>
              )}
            </button>

            {offlineQueueCount > 0 && (
              <button
                onClick={handleSync}
                disabled={isSyncing || !isOnline}
                className="flex items-center space-x-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition disabled:opacity-50"
                title="Synchronize offline queued items to server"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`}
                />
                <span>Sync ({offlineQueueCount})</span>
              </button>
            )}
          </div>

          {/* Notifications (audit issues, corrections & responses) */}
          {bellSlot}

          {/* User Account & Role Switcher — the LAST control, pinned to the
              far right and shrink-0, so it can never be squeezed or pushed
              off the screen. */}
          <div className="relative shrink-0" ref={userMenu.rootRef}>
            <button
              onClick={() => setShowUserDropdown(!showUserDropdown)}
              data-testid="user-menu-btn"
              className="flex items-center space-x-1.5 sm:space-x-2 px-1 sm:px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 transition"
            >
              {/* Profile photo (stored with the user's profile) or initial fallback */}
              <Avatar
                name={currentUser?.name || "K"}
                url={currentUser?.avatarUrl}
                testid="user-menu-photo"
                imgClass="w-7 h-7 rounded-full object-cover border border-emerald-400/50"
                fallbackClass="w-7 h-7 rounded-full bg-emerald-500/30 border border-emerald-400/50 flex items-center justify-center text-xs font-bold text-emerald-300"
              />
              <div className="text-left hidden sm:block">
                <div className="text-xs font-semibold leading-none text-slate-100">
                  {currentUser?.name || "Kwame Mina"}
                </div>
                <div className="text-[10px] text-emerald-400 font-medium">
                  {currentUser?.role || "OWNER"}
                </div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {showUserDropdown && (
              <div
                className="rounded-xl bg-slate-800 border border-slate-700 shadow-2xl py-2 z-50 overflow-y-auto"
                style={userMenu.panelStyle}
                data-testid="user-account-menu"
              >
                <div className="px-3 py-1.5 border-b border-slate-700/80 mb-1">
                  <div className="text-xs font-semibold text-slate-300">
                    Signed in
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Session secured by your personal password
                  </div>
                </div>
                <div className="px-3 py-2 flex items-center space-x-3 border-b border-slate-700/60 mb-1">
                  <Avatar
                    name={currentUser?.name || "?"}
                    url={currentUser?.avatarUrl}
                    testid="user-menu-photo-lg"
                    imgClass="w-10 h-10 rounded-full object-cover border border-emerald-400/40"
                    fallbackClass="w-10 h-10 rounded-full bg-emerald-500/25 border border-emerald-400/40 flex items-center justify-center font-black text-emerald-300"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white truncate">
                      {currentUser?.name}
                    </div>
                    <div className="text-[10px] text-emerald-400 font-bold">
                      {currentUser?.role}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      {currentUser?.email}
                    </div>
                  </div>
                </div>
                <div className="px-3 py-1 space-y-1">
                  {onOpenOnlineOrdering && (
                    <button
                      onClick={() => {
                        setShowUserDropdown(false);
                        onOpenOnlineOrdering();
                      }}
                      data-testid="open-online-ordering"
                      className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-cyan-500/15 text-slate-200 hover:text-cyan-300 transition flex items-center justify-between"
                    >
                      <span>Online Storefront &amp; Delivery Areas</span>
                      <Globe className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowUserDropdown(false);
                      onOpenProfilePhoto?.();
                    }}
                    data-testid="open-profile-photo"
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-emerald-500/15 text-slate-200 hover:text-emerald-300 transition flex items-center justify-between"
                  >
                    <span>My Profile Photo</span>
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setShowUserDropdown(false);
                      onOpenChangePassword?.();
                    }}
                    data-testid="open-change-password"
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-emerald-500/15 text-slate-200 hover:text-emerald-300 transition flex items-center justify-between"
                  >
                    <span>Change Password</span>
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setShowUserDropdown(false);
                      onLogout?.();
                    }}
                    data-testid="logout-btn"
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold bg-slate-700/70 hover:bg-rose-500/20 text-slate-200 hover:text-rose-300 transition flex items-center justify-between"
                  >
                    <span>Sign out / Switch account</span>
                    <User className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
