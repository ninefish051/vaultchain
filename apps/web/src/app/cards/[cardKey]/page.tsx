"use client";

import Link from "next/link";
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { depositBpsFor } from "@vaultchain/shared";
import { api } from "@/lib/api";
import { bps, cardTitle, gradeLabel, usd } from "@/lib/format";
import { CardImage, ListingTile } from "@/components/CardTile";
import { PriceChart } from "@/components/PriceChart";
import { SalesTable } from "@/components/SalesTable";
import { Badge, Change, Empty, Section, Spinner, Stat } from "@/components/ui";

export default function CardPage({ params }: { params: Promise<{ cardKey: string }> }) {
  const { cardKey } = use(params);
  const { data, isLoading, error } = useQuery({ queryKey: ["card", cardKey], queryFn: () => api.card(cardKey) });

  if (isLoading) return <div className="container-page"><Spinner /></div>;
  if (error || !data?.card) return <div className="container-page pt-10"><Empty title="Card not found" /></div>;
  const { card, price, history, sales, listings } = data;

  return (
    <div className="container-page">
      <Link href="/market?view=cards" className="mt-8 inline-block text-xs text-neutral-400 hover:text-gold">
        ← All cards
      </Link>
      <div className="mt-3 grid gap-8 lg:grid-cols-[360px_1fr]">
        <CardImage src={card.imageUrl} alt={card.name} className="aspect-[3/4] border border-ink-600" />
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="gold">{gradeLabel(card)}</Badge>
            <Badge>{card.language}</Badge>
            {card.year && <Badge>{card.year}</Badge>}
          </div>
          <h1 className="h-title mt-3">{cardTitle(card)}</h1>
          <p className="muted mt-1 font-mono text-xs">{card.canonical}</p>

          <div className="panel mt-6 grid grid-cols-2 gap-6 p-5 sm:grid-cols-4">
            <Stat label="Fair value" value={usd(price?.fairValueUsd)} sub={<Change value={price?.change24hPct} />} />
            <Stat label="30d change" value={<Change value={price?.change30dPct} />} />
            <Stat label="30d volatility" value={bps(price?.volatilityBps)} sub={`${price?.sampleCount ?? 0} samples`} />
            <Stat label="Confidence" value={`${price?.confidence ?? 0}/100`} sub={price?.onChain ? "Published on-chain" : "Off-chain estimate"} />
          </div>

          {price && (
            <div className="mt-4 flex gap-3 rounded-xl border border-ink-600 bg-ink-800/60 p-4 text-sm text-neutral-300">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <span>
                Escrow deposit for this card: <b className="text-white">{bps(depositBpsFor(price.volatilityBps))}</b> of the price from each side (10% + 2 × volatility, capped at 30%). If one side walks away, the other
                is compensated with at least 5% or the price move since signing.
              </span>
            </div>
          )}

          <div className="mt-6">
            <PriceChart history={history} />
          </div>
        </div>
      </div>

      <Section title={`For sale (${listings.length})`} action={<Link href={`/sell?cardKey=${card.cardKey}`} className="text-sm text-gold">Sell this card →</Link>}>
        {listings.length === 0 ? (
          <Empty title="No one is selling this card right now">Set a price alert from your favourites, or ask the agent to watch it.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {listings.map((l) => (
              <ListingTile key={l.id} l={l} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Market data">
        <SalesTable sales={sales} />
      </Section>
    </div>
  );
}
