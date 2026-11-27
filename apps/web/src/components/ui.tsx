"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useChainId } from "wagmi";
import { chainById } from "@vaultchain/shared";
import type { TxState } from "@/lib/contracts";
import { pct } from "@/lib/format";

export function Change({ value, className = "" }: { value?: number; className?: string }) {
  if (value === undefined) return <span className={`text-neutral-500 ${className}`}>—</span>;
  return <span className={`${value > 0 ? "text-up" : value < 0 ? "text-down" : "text-neutral-400"} ${className}`}>{pct(value)}</span>;
}

export function Badge({ tone = "neutral", children }: { tone?: "gold" | "neutral" | "up" | "down" | "blue"; children: ReactNode }) {
  const cls = {
    gold: "border-gold/40 bg-gold/10 text-gold",
    neutral: "border-ink-500 bg-ink-700 text-neutral-300",
    up: "border-up/40 bg-up/10 text-up",
    down: "border-down/40 bg-down/10 text-down",
    blue: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  }[tone];
  return <span className={`chip ${cls}`}>{children}</span>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-400">{sub}</div>}
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-end justify-between gap-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="muted mt-2 max-w-md">{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-neutral-400">
      <Loader2 className="h-4 w-4 animate-spin" /> {label ?? "Loading…"}
    </div>
  );
}

export function TxStatus({ state }: { state: TxState }) {
  const chainId = useChainId();
  const explorer = chainById(chainId)?.blockExplorers?.default.url;
  if (state.status === "idle") return null;
  const link = state.hash && explorer ? `${explorer}/tx/${state.hash}` : undefined;
  return (
    <div
      className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
        state.status === "error" ? "border-down/40 bg-down/10 text-down" : state.status === "success" ? "border-up/40 bg-up/10 text-up" : "border-ink-500 text-neutral-300"
      }`}
    >
      {state.status === "pending" && (
        <span className="flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" /> {state.label ?? "Waiting for confirmation"}…
        </span>
      )}
      {state.status === "success" && "Confirmed on-chain."}
      {state.status === "error" && state.error}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="ml-2 underline">
          View transaction
        </a>
      )}
    </div>
  );
}

export function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-neutral-400">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

export function PageHeader({ title, sub, back }: { title: string; sub?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="pt-8">
      {back && (
        <Link href={back.href} className="text-xs text-neutral-400 hover:text-gold">
          ← {back.label}
        </Link>
      )}
      <h1 className="h-title mt-1">{title}</h1>
      {sub && <p className="muted mt-2 max-w-2xl">{sub}</p>}
    </div>
  );
}
