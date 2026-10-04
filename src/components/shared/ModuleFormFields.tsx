"use client";

/**
 * The single implementation of the dark "module form" input + label pair used by
 * every business module (business dashboard, hardware, electronics, restaurant,
 * block factory, car wash, telecom, poultry, aquaculture).
 *
 * Before this file each module carried its own copy of the same markup; they had
 * silently drifted (different backgrounds, different empty-number handling,
 * test-ids on some units only). Modules keep a two-line local wrapper that only
 * pins their look-and-feel defaults, so every call site keeps working unchanged
 * while the behaviour lives in exactly one place.
 */

export type FieldTone = "slate800" | "slate900";

/** How an empty number input maps into form state. */
export type NumberMode =
  /** "" -> 0 (legacy default of most modules) */
  | "coerce"
  /** "" -> "" (business dashboard: keeps the field blank) */
  | "empty"
  /** "" -> undefined (car wash / telecom: optional numeric fields) */
  | "undefined";

export interface FormFieldProps {
  f: Record<string, any>;
  set: (k: string, v: any) => void;
  label: string;
  k: string;
  t?: string;
  /** When set, renders data-testid={`${testidPrefix}-${k}`} (hardware `hwf-`, car wash `cwf-`, telecom `telf-`). */
  testidPrefix?: string;
  tone?: FieldTone;
  numberMode?: NumberMode;
  [rest: string]: any;
}

export function FormField({
  f,
  set,
  label,
  k,
  t = "text",
  testidPrefix,
  tone = "slate800",
  numberMode = "coerce",
  ...rest
}: FormFieldProps) {
  const surface = tone === "slate900" ? "bg-slate-900" : "bg-slate-800";
  const onChange = (raw: string) => {
    if (t !== "number") return set(k, raw);
    if (raw !== "") return set(k, Number(raw));
    set(k, numberMode === "empty" ? "" : numberMode === "undefined" ? undefined : Number(raw));
  };
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <input
        data-testid={testidPrefix ? `${testidPrefix}-${k}` : undefined}
        type={t}
        value={f[k] ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full px-3 py-2 ${surface} border border-slate-700 rounded-lg text-white text-xs`}
        {...rest}
      />
    </div>
  );
}

export interface FormSelectProps {
  f: Record<string, any>;
  set: (k: string, v: any) => void;
  label: string;
  k: string;
  opts: any[]; // plain strings/keywords, or { v, l, disabled } rows
  testidPrefix?: string;
  /** Explicit test-id override (car wash / telecom pass their own). */
  testid?: string;
  tone?: FieldTone;
}

export function FormSelect({
  f,
  set,
  label,
  k,
  opts,
  testidPrefix,
  testid,
  tone = "slate800",
}: FormSelectProps) {
  const surface = tone === "slate900" ? "bg-slate-900" : "bg-slate-800";
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      <select
        data-testid={testid || (testidPrefix ? `${testidPrefix}-${k}` : undefined)}
        value={f[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        className={`w-full px-3 py-2 ${surface} border border-slate-700 rounded-lg text-white text-xs`}
      >
        {opts.map((o: any) => (
          <option key={o.v ?? o} value={o.v ?? o} disabled={!!o?.disabled}>
            {o.l ?? o}
          </option>
        ))}
      </select>
    </div>
  );
}
