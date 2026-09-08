"use client";

import React, { useState } from "react";
import { Building2, Plus, X } from "lucide-react";
import LocationSelector, { LocationValue } from "./LocationSelector";

interface NewBusinessModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBusinessCreated: (business?: any) => void;
  /** DB id of the acting user — the server verifies this is really the OWNER. */
  actorUserId?: number | null;
}

export default function NewBusinessModal({
  isOpen,
  onClose,
  onBusinessCreated,
  actorUserId = null,
}: NewBusinessModalProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Block Factory");
  const [location, setLocation] = useState<LocationValue>({
    region: "Ashanti",
    district: "Kumasi Metropolitan",
    town: "Kumasi",
  });
  const [managerName, setManagerName] = useState("Ebenezer Mensah");
  const [contactPhone, setContactPhone] = useState("+233 24 500 6000");
  const [initialCapitalGhs, setInitialCapitalGhs] = useState(250000);
  const [monthlyTargetRevenueGhs, setMonthlyTargetRevenueGhs] = useState(120000);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      // No code is sent — the server assigns the next sequential code for the
      // category (e.g. BLOCK-02, WASH-03) and auto-provisions the full
      // operating workspace (metrics, starter stock kit, daily checklist
      // templates) so the new unit's dashboard is complete on first open.
      const res = await fetch("/api/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId,
          name: name || "Mina Kumasi Block & Concrete",
          category,
          region: location.region,
          district: location.district,
          town: location.town,
          managerName,
          contactPhone,
          initialCapitalGhs: Number(initialCapitalGhs),
          monthlyTargetRevenueGhs: Number(monthlyTargetRevenueGhs),
        }),
      });

      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setError("");
        onBusinessCreated(d.business);
        onClose();
      } else {
        setError(d?.error || "Failed to create business unit. Please try again.");
        console.error("Create business failed:", d?.error);
      }
    } catch (err: any) {
      setError(err?.message || "Network error while creating the business unit.");
      console.error("Error creating business:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                Create New Business / Branch
              </h3>
              <p className="text-xs text-slate-400">
                Expand the GoMina 360 enterprise footprint in Ghana
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              Business Name
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Mina Kumasi Block & Concrete Hub"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
            >
              <option value="Poultry Farm">Poultry Farm</option>
              <option value="Block Factory">Block Factory</option>
              <option value="Aquaculture">Aquaculture</option>
              <option value="Livestock">Livestock</option>
              <option value="Restaurant & Food">Restaurant & Food</option>
              <option value="Electronic Shop">Electronic Shop</option>
              <option value="Car Wash">Car Wash</option>
              <option value="Hardware Store">Hardware Store (Construction & Building Materials)</option>
              <option value="Telecom & Digital Services">Telecom & Digital Services (MoMo, Airtime, Data, Wi-Fi)</option>
            </select>
          </div>

          <div className="pt-1 border-t border-slate-800">
            <LocationSelector
              value={location}
              onChange={setLocation}
              compact
              required
              headingLabel="Branch Location (Ghana)"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Assigned Branch Manager
              </label>
              <input
                type="text"
                value={managerName}
                onChange={(e) => setManagerName(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Contact Phone
              </label>
              <input
                type="text"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Initial Capital (GH₵)
              </label>
              <input
                type="number"
                value={initialCapitalGhs}
                onChange={(e) => setInitialCapitalGhs(Number(e.target.value))}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Monthly Target Revenue (GH₵)
              </label>
              <input
                type="number"
                value={monthlyTargetRevenueGhs}
                onChange={(e) => setMonthlyTargetRevenueGhs(Number(e.target.value))}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
          </div>

          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-[11px] text-emerald-200/90 leading-relaxed">
            <span className="font-bold text-emerald-300">Auto-provisioned on creation:</span> the exact same
            complete dashboard and features as the original {category} unit — full operations module, starter
            stock kit funded from initial capital, specialized daily-checklist templates, and live links into
            Inventory, Sales, Finance, Expenses, Activities, Alerts, Checklists and enterprise Reports — ready
            the moment the unit opens.
          </div>

          <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
            >
              {isSubmitting ? "Creating..." : "Create Business Unit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
