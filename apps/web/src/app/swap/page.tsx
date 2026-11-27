"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ShieldCheck, Vault } from "lucide-react";
import { api } from "@/lib/api";
import { ListingTile } from "@/components/CardTile";
import { Empty, PageHeader, Section, Spinner } from "@/components/ui";
import { short, usd } from "@/lib/format";

export default function SwapHall() {
  const listings = useQuery({ queryKey: ["listings", "swap"], queryFn: () => api.listings({ acceptsSwap: "true" }) });
  const offers = useQuery({ queryKey: ["swap-offers"], queryFn: () => api.swapOffers() });

  return (
    <div className="container-page">
      <PageHeader
        title="Swap"
        sub="Trade graded cards card-for-card, e.g. PSA 10 for PSA 10. The fair-value difference is settled with a USDC top-up. Raw cards are not supported."
      />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <Vault className="h-5 w-5 text-gold" />
          <div className="mt-2 font-semibold">Both cards in the vault</div>
          <p className="muted mt-1">One atomic transaction swaps the two NFTs and the top-up. No deposits, no shipping. $5 fee per side.</p>
        </div>
        <div className="panel p-5">
          <ShieldCheck className="h-5 w-5 text-gold" />
          <div className="mt-2 font-semibold">One or both cards still physical</div>
          <p className="muted mt-1">
            Both sides sign and lock a deposit (sized from both cards&apos; volatility). Physical cards ship to the vault and are inspected one by one; then each side receives the other card. Whoever
            fails to ship compensates the other.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <Link href="/swap/new" className="btn-gold">
          <ArrowLeftRight className="h-4 w-4" /> Propose a swap
        </Link>
      </div>

      {(offers.data?.length ?? 0) > 0 && (
        <Section title="Open vault swap offers">
          <div className="panel divide-y divide-ink-700">
            {offers.data!.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  #{o.id} by {short(o.maker)} · wants {o.wantSlabId ? "a specific slab" : "any slab of a card type"}
                </span>
                <span className="text-neutral-400">
                  {o.topUpUsd > 0 ? `${o.makerPaysTopUp ? "maker adds" : "taker adds"} ${usd(o.topUpUsd)}` : "even swap"}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Cards open to swaps">
        {listings.isLoading ? (
          <Spinner />
        ) : (listings.data ?? []).length === 0 ? (
          <Empty title="No cards are marked open to swaps yet" />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {listings.data!.map((l) => (
              <ListingTile key={l.id} l={l} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
