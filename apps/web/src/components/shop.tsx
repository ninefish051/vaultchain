"use client";

import { useRef, type ComponentType, type ReactNode } from "react";
import { Check, CreditCard, Gem, Info, ScanSearch, TrendingDown, TrendingUp, Truck, Wallet } from "lucide-react";

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

/* ------------------------------------------------------------------ icon steps */

export type Step = { label: string; icon: Icon; hint?: string };

/** The escrow purchase as five icon steps (with the time each side has). */
export const ESCROW_STEPS: Step[] = [
  { label: "Deposit", icon: Wallet, hint: "1 day" },
  { label: "Seller ships", icon: Truck, hint: "3 days" },
  { label: "Vault check", icon: ScanSearch, hint: "2 days" },
  { label: "Pay balance", icon: CreditCard, hint: "2 days" },
  { label: "It's yours", icon: Gem },
];

/**
 * Horizontal icon stepper. Without `current` it is a preview of the flow;
 * with `current` the finished steps are filled and the active one is highlighted.
 */
export function StepBar({ steps, current, compact = false }: { steps: Step[]; current?: number; compact?: boolean }) {
  return (
    <ol className="grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s, i) => {
        const done = current !== undefined && i < current;
        const active = current !== undefined && i === current;
        const Icon = done ? Check : s.icon;
        return (
          <li key={s.label} className="relative flex flex-col items-center text-center">
            {i > 0 && (
              <span
                aria-hidden
                className={`absolute right-1/2 top-[18px] h-px w-full ${done || active ? "bg-gold/60" : "bg-ink-500"} ${compact ? "top-[15px]" : ""}`}
              />
            )}
            <span
              className={`relative z-10 flex items-center justify-center rounded-full border transition ${compact ? "h-8 w-8" : "h-9 w-9"} ${
                done
                  ? "border-gold bg-gold text-ink-900"
                  : active
                    ? "border-gold bg-ink-800 text-gold shadow-[0_0_0_4px_rgba(232,184,74,0.15)]"
                    : current === undefined
                      ? "border-ink-500 bg-ink-800 text-gold"
                      : "border-ink-500 bg-ink-800 text-neutral-500"
              }`}
            >
              <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} strokeWidth={2} />
            </span>
            <span className={`mt-2 text-[11px] font-medium leading-tight sm:text-xs ${active ? "text-white" : done ? "text-neutral-300" : current === undefined ? "text-neutral-200" : "text-neutral-500"}`}>
              {s.label}
            </span>
            {s.hint && <span className="mt-0.5 text-[10px] text-neutral-500 sm:text-[11px]">{s.hint}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ small pieces */

/** Icon + one short line. Used for trust points ("Escrow protected", "Vault inspected"). */
export function Perk({ icon: Icon, children }: { icon: Icon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
      <Icon className="h-3.5 w-3.5 text-gold" strokeWidth={2} />
      {children}
    </span>
  );
}

/** Price compared with the oracle fair value: green when it is a deal. */
export function FairChip({ price, fair }: { price: number; fair?: number }) {
  if (!fair) return null;
  const diff = ((price - fair) / fair) * 100;
  if (Math.abs(diff) < 0.5) {
    return <span className="chip border-ink-500 bg-ink-700 text-neutral-300">At fair value</span>;
  }
  const below = diff < 0;
  const Icon = below ? TrendingDown : TrendingUp;
  return (
    <span className={`chip ${below ? "border-up/40 bg-up/10 text-up" : "border-gold/30 bg-gold/10 text-gold"}`}>
      <Icon className="h-3 w-3" strokeWidth={2.25} />
      {Math.abs(diff).toFixed(1)}% {below ? "below" : "above"} fair
    </span>
  );
}

/** An (i) icon that shows a short explanation on hover or keyboard focus. */
export function InfoTip({ children, align = "center" }: { children: ReactNode; align?: "center" | "right" }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button type="button" aria-label="More info" className="rounded-full text-neutral-500 transition hover:text-neutral-200 focus:text-neutral-200 focus:outline-none">
        <Info className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute bottom-full z-30 mb-2 w-60 rounded-lg border border-ink-500 bg-ink-700 px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-neutral-200 opacity-0 shadow-xl transition group-hover:opacity-100 group-focus-within:opacity-100 ${
          align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/** A selectable option shown as a card with an icon (replaces a <select>). */
export function ChoiceCard({ icon: Icon, title, sub, selected, onSelect }: { icon: Icon; title: string; sub: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
        selected ? "border-gold bg-gold/10" : "border-ink-500 bg-ink-900 hover:border-ink-500/80 hover:bg-ink-700"
      }`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-gold text-ink-900" : "bg-ink-700 text-neutral-300"}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <span className="min-w-0">
        <span className={`block text-sm font-semibold ${selected ? "text-white" : "text-neutral-200"}`}>{title}</span>
        <span className="mt-0.5 block text-xs text-neutral-400">{sub}</span>
      </span>
    </button>
  );
}

/** Label + value with an icon, for the key numbers of a deal. */
export function Fact({ icon: Icon, label, value, tip }: { icon: Icon; label: string; value: ReactNode; tip?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-600 bg-ink-900/60 p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          {label}
          {tip && <InfoTip>{tip}</InfoTip>}
        </div>
        <div className="truncate text-sm font-semibold text-white">{value}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ holo card */

/** Card image that tilts toward the pointer with a foil sheen, like holding a slab under a light. */
export function HoloCard({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  function move(e: React.PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--rx", `${(0.5 - y) * 10}deg`);
    el.style.setProperty("--ry", `${(x - 0.5) * 12}deg`);
    el.style.setProperty("--mx", `${x * 100}%`);
    el.style.setProperty("--my", `${y * 100}%`);
  }
  function leave() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }
  return (
    <div className={`holo-wrap ${className}`} onPointerMove={move} onPointerLeave={leave}>
      <div ref={ref} className="holo-card relative overflow-hidden rounded-2xl bg-gradient-to-b from-ink-700 to-ink-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-full w-full object-contain p-3 drop-shadow-[0_12px_32px_rgba(0,0,0,0.65)]" />
        <span aria-hidden className="holo-shine" />
      </div>
    </div>
  );
}
