"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Bot, Gavel, LineChart, ShieldCheck, Vault } from "lucide-react";
import { api } from "@/lib/api";
import { CardTypeTile, ListingTile } from "@/components/CardTile";
import { Section, Spinner } from "@/components/ui";

const STEPS = [
  { icon: Gavel, title: "Sign once, both lock a deposit", body: "Buyer and seller sign the terms on-chain. Each locks a deposit sized from the card's 30-day volatility, so nobody can walk away when the price moves." },
  { icon: ShieldCheck, title: "Vault inspects the slab", body: "The seller ships to the vault. The cert is checked against PSA and the inspection result is signed on-chain." },
  { icon: Vault, title: "Settle, ship or keep it vaulted", body: "Pay in full and the card ships to you, or stays in the vault as an NFT you can resell instantly or redeem any time." },
  { icon: ArrowLeftRight, title: "Swap PSA 10 for PSA 10", body: "Trade card-for-card with a USDC top-up for the difference. Same two-sided protection, or instant when both cards are vaulted." },
];

export default function Home() {
  const cards = useQuery({ queryKey: ["cards", "home"], queryFn: () => api.cards({ sort: "change_desc" }) });
  const listings = useQuery({ queryKey: ["listings", "home"], queryFn: () => api.listings() });

  const movers = (cards.data ?? []).slice(0, 5);
  const decliners = [...(cards.data ?? [])].sort((a, b) => (a.price?.change24hPct ?? 0) - (b.price?.change24hPct ?? 0)).slice(0, 5);

  return (
    <div className="container-page">
      <section className="relative mt-10 overflow-hidden rounded-3xl border border-ink-600 bg-gradient-to-br from-ink-800 via-ink-900 to-ink-900 p-8 sm:p-12">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gold/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <span className="chip border-gold/40 bg-gold/10 text-gold">On-chain escrow · HashKey Chain</span>
          <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Graded cards, traded <span className="text-gold">without refund games.</span>
          </h1>
          <p className="mt-4 text-neutral-300">
            Both sides lock a deposit. The vault inspects. The contract settles. Fair prices come from eBay, PriceCharting, Carousell and 集换社 sales,
            signed on-chain.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/market" className="btn-gold">
              Browse the market
            </Link>
            <Link href="/swap" className="btn-ghost">
              <ArrowLeftRight className="h-4 w-4" /> Swap a card
            </Link>
            <Link href="/agent" className="btn-ghost">
              <Bot className="h-4 w-4" /> Ask the agent
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div key={s.title} className="panel p-5">
            <s.icon className="h-5 w-5 text-gold" />
            <div className="mt-3 font-semibold">{s.title}</div>
            <p className="muted mt-1.5 leading-relaxed">{s.body}</p>
          </div>
        ))}
      </section>

      <Section title="Movers today" action={<Link href="/market" className="text-sm text-gold">All cards →</Link>}>
        {cards.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {[
              { title: "Top gainers", rows: movers },
              { title: "Top decliners", rows: decliners },
            ].map((col) => (
              <div key={col.title} className="panel p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <LineChart className="h-4 w-4 text-gold" /> {col.title}
                </div>
                {col.rows.map((c) => (
                  <Link key={c.cardKey} href={`/cards/${c.cardKey}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-ink-700">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.imageUrl} alt="" className="h-12 w-9 rounded object-contain" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{c.name}</div>
                      <div className="text-xs text-neutral-500">
                        {c.setName} · {c.grader} {c.grade}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-medium">${c.price?.fairValueUsd.toLocaleString()}</div>
                      <div className={(c.price?.change24hPct ?? 0) >= 0 ? "text-up" : "text-down"}>
                        {(c.price?.change24hPct ?? 0) >= 0 ? "+" : ""}
                        {c.price?.change24hPct.toFixed(2)}%
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Just listed" action={<Link href="/market?view=listings" className="text-sm text-gold">All listings →</Link>}>
        {listings.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {(listings.data ?? []).slice(0, 10).map((l) => (
              <ListingTile key={l.id} l={l} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Most valuable">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[...(cards.data ?? [])]
            .sort((a, b) => (b.price?.fairValueUsd ?? 0) - (a.price?.fairValueUsd ?? 0))
            .slice(0, 5)
            .map((c) => (
              <CardTypeTile key={c.cardKey} c={c} />
            ))}
        </div>
      </Section>
    </div>
  );
}
