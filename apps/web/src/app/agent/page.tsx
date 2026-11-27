"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, ShieldCheck } from "lucide-react";
import { useAccount } from "wagmi";
import { agentChat, type AgentAction } from "@/lib/api";
import { errorMessage } from "@/lib/contracts";
import { usd } from "@/lib/format";
import { PageHeader } from "@/components/ui";

type Msg = { role: "user" | "assistant"; content: string; actions?: AgentAction[] };

const SUGGESTIONS = [
  "Find me a PSA 10 Base Set Charizard under $13,000 and tell me if any listing is below fair value.",
  "Which PSA 10 cards could I swap my Umbreon VMAX alt art for, and what top-up would that need?",
  "How volatile is Lugia Neo Genesis PSA 10 and what deposit would an escrow order need?",
];

function ActionCard({ a }: { a: AgentAction }) {
  if (a.type === "order")
    return (
      <div className="mt-2 rounded-xl border border-gold/40 bg-gold/5 p-3 text-sm">
        <div className="font-semibold text-gold">Escrow order ready to sign</div>
        <div className="mt-1">
          {usd(a.priceUsd as number)} · deposit {usd(a.depositUsd as number, true)} · {a.fulfillment === "KeepInVault" ? "keep in vault" : "ship to you"}
        </div>
        {(a.warnings as string[] | undefined)?.map((w) => (
          <div key={w} className="text-xs text-gold">⚠ {w}</div>
        ))}
        <Link className="btn-gold mt-2" href={`/listings/${encodeURIComponent(a.listingId as string)}`}>Review &amp; sign</Link>
      </div>
    );
  if (a.type === "swap")
    return (
      <div className="mt-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3 text-sm">
        <div className="font-semibold text-sky-300">Swap ready to propose</div>
        <div className="mt-1">
          Top-up {usd(a.topUpUsd as number)} {a.topUpFrom === 1 ? "from you" : a.topUpFrom === 2 ? "from them" : ""} · deposit {usd(a.depositUsd as number, true)}
        </div>
        <Link className="btn-ghost mt-2" href={`/swap/new?want=${encodeURIComponent(a.theirListingId as string)}`}>Review &amp; sign</Link>
      </div>
    );
  return (
    <div className="mt-2 rounded-xl border border-gold/40 bg-gold/5 p-3 text-sm">
      <div className="font-semibold text-gold">Payment needs your approval</div>
      <div className="mt-1">{String(a.note)}</div>
      <Link className="btn-gold mt-2" href={`/${a.target === "order" ? "orders" : "swaps"}/${a.id as string}`}>Open and pay with HSP</Link>
    </div>
  );
}

export default function AgentPage() {
  const { address } = useAccount();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [maxPerOrder, setMaxPerOrder] = useState<number | "">("");
  const [budget, setBudget] = useState<number | "">("");
  // what the agent has already drafted for the user this session (orders at price, swap top-ups we pay)
  const spentUsd = messages
    .flatMap((m) => m.actions ?? [])
    .reduce((sum, a) => sum + (a.type === "order" ? Number(a.priceUsd) : a.type === "swap" && a.topUpFrom === 1 ? Number(a.topUpUsd) : 0), 0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(undefined);
    try {
      const r = await agentChat({
        messages: next.map(({ role, content }) => ({ role, content })),
        userAddress: address,
        limits: { maxPerOrderUsd: maxPerOrder || undefined, totalBudgetUsd: budget || undefined, spentUsd },
      });
      setMessages([...next, { role: "assistant", content: r.reply, actions: r.actions }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container-page max-w-3xl">
      <PageHeader
        title="Buyer agent"
        sub="Ask in plain language. The agent searches the catalogue, checks fair value against recent sales, negotiates with seller agents and drafts orders or swaps. It never signs or pays: you approve every payment in your wallet."
      />
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <ShieldCheck className="h-4 w-4 text-gold" />
        <span className="text-neutral-400">Spending limit per order (USD)</span>
        <input className="input w-32" type="number" inputMode="decimal" min={0} placeholder="no limit" value={maxPerOrder} onChange={(e) => setMaxPerOrder(e.target.value ? Number(e.target.value) : "")} />
        <span className="text-neutral-400">Session budget</span>
        <input className="input w-32" type="number" inputMode="decimal" min={0} placeholder="no limit" value={budget} onChange={(e) => setBudget(e.target.value ? Number(e.target.value) : "")} />
        {spentUsd > 0 && <span className="text-xs text-neutral-500">drafted so far ${spentUsd.toLocaleString()}</span>}
      </div>

      <div className="panel mt-4 flex min-h-[420px] flex-col p-4">
        {messages.length === 0 && (
          <div className="my-auto grid gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} className="rounded-xl border border-ink-600 px-4 py-3 text-left text-sm text-neutral-300 hover:border-gold/50">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-4 flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
            {m.role === "assistant" && <Bot className="mt-1 h-5 w-5 shrink-0 text-gold" />}
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role === "user" ? "bg-gold text-ink-900" : "bg-ink-700"}`}>
              {m.content}
              {m.actions?.map((a, j) => <ActionCard key={j} a={a} />)}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking prices and listings…
          </div>
        )}
        {error && <div className="text-sm text-down">{error}</div>}
        <div ref={end} />
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input className="input" placeholder="e.g. Swap my PSA 10 Blastoise for a PSA 10 Venusaur" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn-gold" disabled={busy || !input.trim()}>
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
