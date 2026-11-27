"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useSignMessage } from "wagmi";
import { api, type OfferWithListing } from "@/lib/api";
import { errorMessage } from "@/lib/contracts";
import { short, usd } from "@/lib/format";
import { Badge } from "./ui";

const TONE: Record<string, "gold" | "up" | "down" | "neutral" | "blue"> = { open: "neutral", accepted: "up", rejected: "down", countered: "gold", expired: "neutral" };

function SellerActions({ o, me }: { o: OfferWithListing; me: Address }) {
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const [counter, setCounter] = useState<number | "">("");
  const [err, setErr] = useState<string>();
  const respond = async (action: "accept" | "reject" | "counter") => {
    try {
      await api.respondOffer(o.id, { listingId: o.listingId, action, counterUsd: action === "counter" ? Number(counter) : undefined }, me, signMessageAsync);
      qc.invalidateQueries({ queryKey: ["offers"] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  if (o.status !== "open") return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button className="btn-gold py-1.5" onClick={() => respond("accept")}>Accept</button>
      <button className="btn-ghost py-1.5" onClick={() => respond("reject")}>Reject</button>
      <input className="input w-28 py-1.5" type="number" inputMode="decimal" placeholder="Counter $" value={counter} onChange={(e) => setCounter(e.target.value ? Number(e.target.value) : "")} />
      <button className="btn-ghost py-1.5" disabled={!counter} onClick={() => respond("counter")}>Counter</button>
      {err && <span className="text-xs text-down">{err}</span>}
    </div>
  );
}

/**
 * Offers lifecycle: buyers see their offers and, once accepted or countered, sign the escrow order
 * at that price; sellers answer offers on their listings (their seller agent may do it automatically).
 */
export function Offers({ me }: { me: Address }) {
  const made = useQuery({ queryKey: ["offers", "buyer", me], queryFn: () => api.offersFor({ buyer: me }) });
  const received = useQuery({ queryKey: ["offers", "seller", me], queryFn: () => api.offersFor({ seller: me }) });

  const row = (o: OfferWithListing, side: "buyer" | "seller") => {
    const agreed = o.status === "accepted" ? o.priceUsd : o.status === "countered" ? o.counterUsd : undefined;
    return (
      <div key={o.id} className="px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-medium">{o.listing ? `${o.listing.card.name} ${o.listing.card.grader} ${o.listing.card.grade}` : o.listingId}</span>
            <span className="ml-2 text-neutral-400">
              offer {usd(o.priceUsd)}
              {o.listing && ` · ask ${usd(o.listing.priceUsd)}`}
              {side === "seller" && ` · from ${short(o.buyer)}`}
              {o.counterUsd !== undefined && ` · counter ${usd(o.counterUsd)}`}
            </span>
          </div>
          <Badge tone={TONE[o.status] ?? "neutral"}>{o.status}</Badge>
        </div>
        {side === "buyer" && agreed !== undefined && (
          <Link className="btn-gold mt-2 py-1.5" href={`/listings/${encodeURIComponent(o.listingId)}?price=${agreed}`}>
            Sign escrow order at {usd(agreed)}
          </Link>
        )}
        {side === "seller" && <SellerActions o={o} me={me} />}
      </div>
    );
  };

  const mine = made.data ?? [];
  const theirs = received.data ?? [];
  if (mine.length === 0 && theirs.length === 0) return null;
  return (
    <>
      {theirs.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold">Offers on your listings</h2>
          <div className="panel mt-3 divide-y divide-ink-700">{theirs.map((o) => row(o, "seller"))}</div>
        </>
      )}
      {mine.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold">Your offers</h2>
          <div className="panel mt-3 divide-y divide-ink-700">{mine.map((o) => row(o, "buyer"))}</div>
        </>
      )}
    </>
  );
}
