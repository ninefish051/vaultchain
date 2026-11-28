"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, BadgeCheck, LineChart, Lock, ScanSearch, ShieldCheck, Store, TrendingUp, Vault } from "lucide-react";
import { api } from "@/lib/api";
import { CardTypeTile, ListingTile } from "@/components/CardTile";
import { Section, Spinner } from "@/components/ui";

const STEPS = [
  { icon: Lock, title: "Both sides lock a deposit", body: "Nobody walks away when prices move." },
  { icon: ScanSearch, title: "The vault checks the slab", body: "Cert verified, result signed on-chain." },
  { icon: Vault, title: "Keep it or ship it", body: "Get an NFT, or have it delivered." },
  { icon: ArrowLeftRight, title: "Swap card for card", body: "Top up the difference in USDC." },
];

export default function Home() {
  const cards = useQuery({ queryKey: ["cards", "home"], queryFn: () => api.cards({ sort: "change_desc" }) });
  const listings = useQuery({ queryKey: ["listings", "home"], queryFn: () => api.listings() });

  const movers = (cards.data ?? []).slice(0, 5);
  const decliners = [...(cards.data ?? [])].sort((a, b) => (a.price?.change24hPct ?? 0) - (b.price?.change24hPct ?? 0)).slice(0, 5);

  return (
    <div className="container-page">
      <section className="relative mt-6 overflow-hidden rounded-3xl border border-ink-600 bg-gradient-to-br from-ink-800 via-ink-900 to-ink-900 p-6 sm:mt-10 sm:p-12">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gold/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <span className="chip border-gold/40 bg-gold/10 text-gold">On-chain escrow · HashKey Chain</span>
          <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            Graded cards, traded <span className="text-gold">without refund games.</span>
          </h1>
          <p className="mt-4 text-neutral-300">PSA, BGS and CGC slabs with escrow, vault inspection and on-chain fair prices.</p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-neutral-300">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-gold" /> Escrow protected</span>
            <span className="inline-flex items-center gap-1.5"><BadgeCheck className="h-4 w-4 text-gold" /> Graded slabs only</span>
            <span className="inline-flex items-center gap-1.5"><TrendingUp className="h-4 w-4 text-gold" /> Live fair value</span>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap">
            <Link href="/market" className="btn-gold">
              <Store className="h-4 w-4" /> Shop the market
            </Link>
            <Link href="/swap" className="btn-ghost">
              <ArrowLeftRight className="h-4 w-4" /> Swap a card
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div key={s.title} className="panel flex items-start gap-3 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/10 text-gold">
              <s.icon className="h-5 w-5" />
            </span>
            <div>
              <div className="font-semibold">{s.title}</div>
              <p className="mt-0.5 text-sm text-neutral-400">{s.body}</p>
            </div>
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
