"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ShieldCheck, Vault } from "lucide-react";
import { useAccount, usePublicClient, useSignMessage, useSignTypedData } from "wagmi";
import { toUsd6, vaultMarketAbi } from "@vaultchain/shared";
import type { Abi } from "viem";
import { api, type OrderQuote } from "@/lib/api";
import { ensureAllowance, errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { bps, cardTitle, gradeLabel, short, usd } from "@/lib/format";
import { buildOrderTerms, orderTypedData, toJson } from "@/lib/terms";
import { CardImage } from "@/components/CardTile";
import { Badge, Empty, KV, Spinner, TxStatus } from "@/components/ui";

export default function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const agreed = Number(useSearchParams().get("price")) || undefined; // from an accepted / countered offer
  const { data: l, isLoading } = useQuery({ queryKey: ["listing", id], queryFn: () => api.listing(decodeURIComponent(id)) });
  const { address, isConnected } = useAccount();
  const { chainId, deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const tx = useTx();

  const [price, setPrice] = useState<number>(0);
  const [keepInVault, setKeepInVault] = useState(true);
  const [quote, setQuote] = useState<OrderQuote>();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string }>();

  useEffect(() => {
    if (l) setPrice(agreed ?? l.priceUsd);
  }, [l, agreed]);
  useEffect(() => {
    if (!l || l.type !== "escrow" || !price) return;
    const t = setTimeout(() => api.quoteOrder(l.cardKey, price).then(setQuote).catch(() => setQuote(undefined)), 250);
    return () => clearTimeout(t);
  }, [l, price]);

  if (isLoading) return <div className="container-page"><Spinner /></div>;
  if (!l?.card) return <div className="container-page pt-10"><Empty title="Listing not found" /></div>;
  const mine = address?.toLowerCase() === l.seller.toLowerCase();

  async function buyVault() {
    if (!deployment || !address || !publicClient || !l?.tokenId) return;
    await tx.run(async (write) => {
      await ensureAllowance(write, publicClient, deployment.usdc, address, deployment.market, toUsd6(l.priceUsd));
      return write({ address: deployment.market, abi: vaultMarketAbi as Abi, functionName: "buy", args: [BigInt(l.tokenId!), toUsd6(l.priceUsd)], label: "Buying" });
    });
  }

  /** Escrow: the buyer signs OrderTerms; the seller countersigns and submits createOrder. */
  async function proposeOrder() {
    if (!deployment || !address || !l) return;
    try {
      const terms = buildOrderTerms({ buyer: address, seller: l.seller, cardKey: l.cardKey, slabId: l.slabId, certNumber: l.certNumber, priceUsd: price, keepInVault });
      const sig = await signTypedDataAsync(orderTypedData(chainId, deployment.escrow, terms));
      await api.createProposal({ kind: "order", counterparty: l.seller, terms: toJson(terms), proposerSig: sig }, address, signMessageAsync);
      setMsg({ tone: "ok", text: "Signed order sent to the seller. Once they countersign, you lock your deposit from Orders." });
      setTimeout(() => router.push("/orders"), 1500);
    } catch (e) {
      setMsg({ tone: "err", text: errorMessage(e) });
    }
  }

  async function makeOffer() {
    if (!address || !l) return;
    try {
      await api.createOffer({ listingId: l.id, priceUsd: price }, address, signMessageAsync);
      setMsg({ tone: "ok", text: "Offer sent. The seller (or their agent) can accept or counter." });
    } catch (e) {
      setMsg({ tone: "err", text: errorMessage(e) });
    }
  }

  return (
    <div className="container-page">
      <Link href={`/cards/${l.cardKey}`} className="mt-8 inline-block text-xs text-neutral-400 hover:text-gold">
        ← {l.card.name} prices
      </Link>
      <div className="mt-3 grid gap-8 lg:grid-cols-[400px_1fr]">
        <CardImage src={l.images[0] ?? l.card.imageUrl} alt={l.card.name} className="aspect-[3/4] border border-ink-600" />
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="gold">{gradeLabel(l.card)}</Badge>
            {l.type === "vault" ? (
              <Badge tone="up"><Vault className="h-3 w-3" /> In vault · instant settlement</Badge>
            ) : (
              <Badge tone="blue"><ShieldCheck className="h-3 w-3" /> With seller · escrow + inspection</Badge>
            )}
            {l.acceptsSwap && <Badge><ArrowLeftRight className="h-3 w-3" /> Open to swaps</Badge>}
          </div>
          <h1 className="h-title mt-3">{cardTitle(l.card)}</h1>
          <div className="mt-1 text-sm text-neutral-400">
            {l.card.grader} cert #{l.certNumber} · seller {short(l.seller)}
          </div>

          <div className="panel mt-6 p-5">
            <div className="flex items-end justify-between">
              <div>
                <div className="label">Asking price</div>
                <div className="text-3xl font-bold">{usd(l.priceUsd)}</div>
              </div>
              <div className="text-right text-sm">
                <div className="text-neutral-400">Fair value</div>
                <div className="font-semibold">{usd(l.price?.fairValueUsd)}</div>
              </div>
            </div>

            {mine ? (
              <p className="muted mt-5">This is your listing. Manage it from <Link href="/assets" className="text-gold">Assets</Link>.</p>
            ) : l.type === "vault" ? (
              <>
                <p className="muted mt-4">The NFT and USDC swap in one transaction. You can redeem the physical slab from the vault at any time.</p>
                <button className="btn-gold mt-4 w-full" disabled={!isConnected || !deployment || tx.state.status === "pending"} onClick={buyVault}>
                  {isConnected ? `Buy now for ${usd(l.priceUsd)}` : "Connect a wallet to buy"}
                </button>
                <TxStatus state={tx.state} />
              </>
            ) : (
              <>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">Your price (USD)</label>
                    <input className="input" type="number" min={1} value={price || ""} onChange={(e) => setPrice(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className="label">After inspection</label>
                    <select className="input" value={keepInVault ? "vault" : "ship"} onChange={(e) => setKeepInVault(e.target.value === "vault")}>
                      <option value="vault">Keep in vault (mint NFT)</option>
                      <option value="ship">Ship to me</option>
                    </select>
                  </div>
                </div>
                {quote && (
                  <div className="mt-4 rounded-xl border border-ink-600 p-3">
                    <KV k="Deposit per side" v={`${usd(quote.depositUsd, true)} (${bps(quote.depositBps)})`} />
                    <KV k="vs fair value" v={`${quote.deviationPct > 0 ? "+" : ""}${quote.deviationPct}%`} />
                    <KV k="Timeline" v="1d deposits · 3d ship · 2d inspect · 2d pay" />
                    {quote.warnings.map((w) => (
                      <div key={w} className="mt-1 text-xs text-gold">⚠ {w}</div>
                    ))}
                  </div>
                )}
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <button className="btn-gold" disabled={!isConnected || !deployment || !price} onClick={proposeOrder}>
                    Sign escrow order
                  </button>
                  <button className="btn-ghost" disabled={!isConnected || !price || price >= l.priceUsd} onClick={makeOffer}>
                    Make an offer
                  </button>
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Signing costs nothing. Your deposit is only locked after the seller countersigns. If either side then backs out, their deposit compensates the other.
                </p>
              </>
            )}
            {l.acceptsSwap && !mine && (
              <Link href={`/swap/new?want=${encodeURIComponent(l.id)}`} className="btn-ghost mt-3 w-full">
                <ArrowLeftRight className="h-4 w-4" /> Propose a swap instead
              </Link>
            )}
            {msg && <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-up" : "text-down"}`}>{msg.text}</div>}
          </div>
          {l.swapWants && <p className="muted mt-3">Seller would swap for: {l.swapWants}</p>}
          {!deployment && isConnected && <p className="mt-3 text-xs text-gold">Switch to a network where VaultChain is deployed to trade.</p>}
        </div>
      </div>
    </div>
  );
}
