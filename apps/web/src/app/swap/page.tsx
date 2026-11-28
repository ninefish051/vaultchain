"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Lock, PackageX, Receipt, ScanSearch, ShieldCheck, Truck, Zap } from "lucide-react";
import { InfoTip, Perk } from "@/components/shop";
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
        sub="Trade card for card. Top up the difference in USDC."
      />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold"><Zap className="h-5 w-5" /></span>
          <div className="mt-3 font-semibold">Both cards in the vault</div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            <Perk icon={Zap}>Instant swap</Perk>
            <Perk icon={PackageX}>No shipping</Perk>
            <Perk icon={Receipt}>$5 fee per side</Perk>
          </div>
        </div>
        <div className="panel p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold"><ShieldCheck className="h-5 w-5" /></span>
          <div className="mt-3 flex items-center gap-1.5 font-semibold">
            One or both cards still physical
            <InfoTip>Whoever fails to ship compensates the other side from their deposit.</InfoTip>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            <Perk icon={Lock}>Both lock a deposit</Perk>
            <Perk icon={Truck}>Ship to the vault</Perk>
            <Perk icon={ScanSearch}>Checked, then swapped</Perk>
          </div>
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
