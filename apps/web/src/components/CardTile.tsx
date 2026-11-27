import Link from "next/link";
import { ArrowLeftRight, ShieldCheck, Vault } from "lucide-react";
import type { CardSummary, ListingView } from "@/lib/api";
import { cardTitle, gradeLabel, usd } from "@/lib/format";
import { Badge, Change } from "./ui";

export function CardImage({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl bg-gradient-to-b from-ink-700 to-ink-800 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="h-full w-full object-contain p-3 drop-shadow-[0_8px_24px_rgba(0,0,0,0.6)]" />
    </div>
  );
}

export function CardTypeTile({ c }: { c: CardSummary }) {
  return (
    <Link href={`/cards/${c.cardKey}`} className="panel group flex flex-col p-3 transition hover:border-gold/50">
      <CardImage src={c.imageUrl} alt={c.name} className="aspect-[3/4]" />
      <div className="mt-3 flex items-center gap-1.5">
        <Badge tone="gold">{gradeLabel(c)}</Badge>
        {c.listingCount > 0 && <Badge>{c.listingCount} listed</Badge>}
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-gold">{cardTitle(c)}</div>
      <div className="mt-auto flex items-end justify-between pt-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Fair value</div>
          <div className="font-semibold">{usd(c.price?.fairValueUsd)}</div>
        </div>
        <Change value={c.price?.change24hPct} className="text-sm font-medium" />
      </div>
      {c.lowestAskUsd !== undefined && <div className="mt-1 text-xs text-neutral-400">From {usd(c.lowestAskUsd)}</div>}
    </Link>
  );
}

export function ListingTile({ l }: { l: ListingView }) {
  const vsFair = l.price ? ((l.priceUsd - l.price.fairValueUsd) / l.price.fairValueUsd) * 100 : undefined;
  return (
    <Link href={`/listings/${encodeURIComponent(l.id)}`} className="panel group flex flex-col p-3 transition hover:border-gold/50">
      <CardImage src={l.images[0] ?? l.card.imageUrl} alt={l.card.name} className="aspect-[3/4]" />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="gold">{gradeLabel(l.card)}</Badge>
        {l.type === "vault" ? (
          <Badge tone="up">
            <Vault className="h-3 w-3" /> Vault · instant
          </Badge>
        ) : (
          <Badge tone="blue">
            <ShieldCheck className="h-3 w-3" /> Escrow · inspected
          </Badge>
        )}
        {l.acceptsSwap && (
          <Badge>
            <ArrowLeftRight className="h-3 w-3" /> Swap
          </Badge>
        )}
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-gold">{cardTitle(l.card)}</div>
      <div className="mt-auto flex flex-wrap items-baseline justify-between gap-x-2 pt-3">
        <div className="text-lg font-semibold">{usd(l.priceUsd)}</div>
        {vsFair !== undefined && (
          <span className={`whitespace-nowrap text-xs ${vsFair <= 0 ? "text-up" : "text-neutral-400"}`}>
            {vsFair <= 0 ? `${Math.abs(vsFair).toFixed(1)}% below fair` : `${vsFair.toFixed(1)}% above fair`}
          </span>
        )}
      </div>
    </Link>
  );
}
