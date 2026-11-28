"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowLeftRight, BadgeCheck, HandCoins, Lock, Package, Repeat, ScanSearch, ShieldCheck, Vault, Zap } from "lucide-react";
import { useAccount, usePublicClient, useSignMessage, useSignTypedData } from "wagmi";
import { toUsd6, vaultMarketAbi } from "@vaultchain/shared";
import type { Abi } from "viem";
import { api, type OrderQuote } from "@/lib/api";
import { ensureAllowance, errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { bps, cardTitle, gradeLabel, short, usd } from "@/lib/format";
import { ChoiceCard, ESCROW_STEPS, Fact, FairChip, HoloCard, InfoTip, Perk, StepBar } from "@/components/shop";
import { buildOrderTerms, orderTypedData, toJson } from "@/lib/terms";
import { Badge, Empty, Spinner, TxStatus } from "@/components/ui";
import { MobileActionBar } from "@/components/MobileTabBar";

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
      <Link href={`/cards/${l.cardKey}`} className="mt-8 inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-gold">
        <ArrowLeft className="h-3.5 w-3.5" /> {l.card.name} prices
      </Link>
      <div className="mt-3 grid gap-8 lg:grid-cols-[400px_1fr]">
        <div>
          <HoloCard src={l.images[0] ?? l.card.imageUrl} alt={l.card.name} className="mx-auto aspect-[3/4] w-full max-w-[280px] sm:max-w-none" />
          <div className="mt-4 hidden flex-wrap justify-center gap-x-5 gap-y-2 lg:flex">
            {l.type === "vault" ? (
              <>
                <Perk icon={Zap}>Instant settlement</Perk>
                <Perk icon={Vault}>Stored in the vault</Perk>
                <Perk icon={Package}>Redeem anytime</Perk>
              </>
            ) : (
              <>
                <Perk icon={ShieldCheck}>Escrow protected</Perk>
                <Perk icon={ScanSearch}>Vault inspected</Perk>
                <Perk icon={Lock}>Deposit-backed</Perk>
              </>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <Badge tone="gold">{gradeLabel(l.card)}</Badge>
            {l.type === "vault" ? (
              <Badge tone="up"><Zap className="h-3 w-3" /> Buy instantly</Badge>
            ) : (
              <Badge tone="blue"><ShieldCheck className="h-3 w-3" /> Escrow + inspection</Badge>
            )}
            {l.acceptsSwap && <Badge><ArrowLeftRight className="h-3 w-3" /> Swappable</Badge>}
            {l.verified && <Badge tone="up"><BadgeCheck className="h-3 w-3" /> Cert verified</Badge>}
          </div>
          <h1 className="h-title mt-3">{cardTitle(l.card)}</h1>
          <div className="mt-1 text-sm text-neutral-400">
            {l.card.grader} #{l.certNumber} · {short(l.seller)}
          </div>

          <div className="panel mt-6 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-4xl font-bold tracking-tight">{usd(l.priceUsd)}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <FairChip price={l.priceUsd} fair={l.price?.fairValueUsd} />
                  <span className="inline-flex items-center gap-1 text-xs text-neutral-400">
                    Fair {usd(l.price?.fairValueUsd)}
                    <InfoTip>Time-weighted median of recent sales (eBay, PriceCharting, Carousell), signed and published on-chain.</InfoTip>
                  </span>
                </div>
              </div>
            </div>

            {mine ? (
              <p className="muted mt-5">This is your listing. Manage it from <Link href="/assets" className="text-gold">Assets</Link>.</p>
            ) : l.type === "vault" ? (
              <>
                <button className="btn-gold mt-5 w-full py-3 text-base" disabled={!isConnected || !deployment || tx.state.status === "pending"} onClick={buyVault}>
                  <Zap className="h-4 w-4" />
                  {isConnected ? `Buy now · ${usd(l.priceUsd)}` : "Connect a wallet to buy"}
                </button>
                <TxStatus state={tx.state} />
              </>
            ) : (
              <>
                <div className="mt-5">
                  <label className="label" htmlFor="price">Your price</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span>
                    <input id="price" className="input pl-7 text-lg font-semibold" type="number" min={1} value={price || ""} onChange={(e) => setPrice(Number(e.target.value))} />
                  </div>
                </div>
                <div className="mt-4">
                  <div className="label">After the check</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ChoiceCard icon={Vault} title="Keep in vault" sub="Get an NFT, resell in one tap" selected={keepInVault} onSelect={() => setKeepInVault(true)} />
                    <ChoiceCard icon={Package} title="Ship to me" sub="Delivered to your door" selected={!keepInVault} onSelect={() => setKeepInVault(false)} />
                  </div>
                </div>
                {quote && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <Fact
                      icon={Lock}
                      label="Deposit"
                      value={`${usd(quote.depositUsd, true)} · ${bps(quote.depositBps)}`}
                      tip="Both sides lock the same deposit. Whoever backs out compensates the other. You get it back when the deal completes."
                    />
                    <Fact icon={ShieldCheck} label="You pay" value={usd(price)} tip="You pay the full price after the vault check passes. Your deposit comes back when the deal completes." />
                  </div>
                )}
                {quote?.warnings.map((w) => (
                  <div key={w} className="mt-2 text-xs text-gold">{w}</div>
                ))}
                <div className="mt-5 rounded-xl border border-ink-600 bg-ink-900/40 px-2 py-4">
                  <StepBar steps={ESCROW_STEPS} />
                </div>
                <div className="mt-5 grid gap-2 sm:grid-cols-[1.4fr_1fr]">
                  <button className="btn-gold py-3 text-base" disabled={!isConnected || !deployment || !price} onClick={proposeOrder}>
                    <ShieldCheck className="h-4 w-4" /> Buy with escrow
                  </button>
                  <button className="btn-ghost py-3" disabled={!isConnected || !price || price >= l.priceUsd} onClick={makeOffer}>
                    <HandCoins className="h-4 w-4" /> Make an offer
                  </button>
                </div>
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-neutral-500">
                  <Lock className="h-3 w-3" /> Free to sign. Nothing is charged until the seller accepts.
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
          {l.swapWants && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs text-neutral-300">
              <Repeat className="h-3.5 w-3.5 text-gold" /> Would swap for: <span className="text-white">{l.swapWants}</span>
            </div>
          )}
          {!deployment && isConnected && <p className="mt-3 text-xs text-gold">Switch to a network where VaultChain is deployed to trade.</p>}
        </div>
      </div>
      {!mine && (
        <MobileActionBar>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase text-neutral-500">{l.type === "vault" ? "Buy now" : "Your price"}</div>
            <div className="text-lg font-bold">{usd(l.type === "vault" ? l.priceUsd : price)}</div>
          </div>
          {l.type === "vault" ? (
            <button className="btn-gold flex-1" disabled={!isConnected || !deployment || tx.state.status === "pending"} onClick={buyVault}>
              {isConnected ? "Buy" : "Connect wallet"}
            </button>
          ) : (
            <button className="btn-gold flex-1" disabled={!isConnected || !deployment || !price} onClick={proposeOrder}>
              {isConnected ? "Buy with escrow" : "Connect wallet"}
            </button>
          )}
        </MobileActionBar>
      )}
    </div>
  );
}
