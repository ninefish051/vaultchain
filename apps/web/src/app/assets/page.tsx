"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Abi } from "viem";
import { useAccount } from "wagmi";
import { DEMO_CARDS, vaultCardNFTAbi } from "@vaultchain/shared";
import { api } from "@/lib/api";
import { useDeployment, useTx } from "@/lib/contracts";
import { cardTitle, gradeLabel, usd } from "@/lib/format";
import { CardImage } from "@/components/CardTile";
import { Badge, Empty, PageHeader, Spinner, Stat, TxStatus } from "@/components/ui";

export default function AssetsPage() {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const tx = useTx();
  const assets = useQuery({ queryKey: ["assets", address], queryFn: () => api.assets(address!), enabled: !!address });
  const cards = useQuery({ queryKey: ["cards", "all"], queryFn: () => api.cards() });
  const myListings = useQuery({ queryKey: ["listings", "mine", address], queryFn: () => api.listings({ seller: address }), enabled: !!address });

  if (!address)
    return (
      <div className="container-page">
        <PageHeader title="Assets" />
        <div className="mt-6"><Empty title="Connect a wallet to see your vault cards" /></div>
      </div>
    );

  const priceOf = (k: string) => cards.data?.find((c) => c.cardKey === k)?.price?.fairValueUsd ?? 0;
  const total = (assets.data ?? []).reduce((a, x) => a + priceOf(x.cardKey), 0);
  const redeem = (tokenId: string, fn: "requestRedeem" | "cancelRedeem") =>
    deployment && tx.run((w) => w({ address: deployment.nft, abi: vaultCardNFTAbi as Abi, functionName: fn, args: [BigInt(tokenId)], label: fn === "requestRedeem" ? "Requesting redemption" : "Cancelling redemption" }));

  return (
    <div className="container-page">
      <PageHeader title="Your vault" sub="Cards held by the VaultChain vault and owned by your wallet as NFTs. Redeeming locks the NFT; it is burned when the vault hands over the slab." />
      <div className="panel mt-6 grid grid-cols-2 gap-6 p-5 sm:grid-cols-3">
        <Stat label="Cards" value={assets.data?.length ?? 0} />
        <Stat label="Value at fair price" value={usd(total)} />
        <Stat label="Active listings" value={myListings.data?.length ?? 0} />
      </div>
      <TxStatus state={tx.state} />
      <div className="mt-6">
        {assets.isLoading ? (
          <Spinner />
        ) : (assets.data ?? []).length === 0 ? (
          <Empty title="No vault cards yet">Buy a vault listing, choose “keep in vault” in an escrow order, or send a slab to the vault for intake.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {assets.data!.map((a) => {
              const c = (cards.data ?? DEMO_CARDS).find((x) => x.cardKey === a.cardKey);
              return (
                <div key={a.tokenId} className="panel flex flex-col p-3">
                  {c && <CardImage src={c.imageUrl} alt="" className="aspect-[3/4]" />}
                  <div className="mt-2 flex gap-1.5">
                    {c && <Badge tone="gold">{gradeLabel(c)}</Badge>}
                    <Badge tone={a.custody === "InVault" ? "up" : "neutral"}>{a.custody}</Badge>
                  </div>
                  <div className="mt-2 text-sm font-medium">{c ? cardTitle(c) : a.cardKey.slice(0, 10)}</div>
                  <div className="text-xs text-neutral-500">cert {a.certNumber}</div>
                  <div className="mt-1 text-sm">{usd(priceOf(a.cardKey))}</div>
                  <div className="mt-3 grid gap-2">
                    {a.custody === "InVault" && (
                      <>
                        <Link className="btn-ghost py-1.5 text-xs" href={`/sell?cardKey=${a.cardKey}`}>Sell</Link>
                        <Link className="btn-ghost py-1.5 text-xs" href="/swap/new">Swap</Link>
                        <button className="btn-ghost py-1.5 text-xs" disabled={!deployment} onClick={() => redeem(a.tokenId, "requestRedeem")}>Redeem slab</button>
                      </>
                    )}
                    {a.custody === "RedeemLocked" && (
                      <button className="btn-ghost py-1.5 text-xs" onClick={() => redeem(a.tokenId, "cancelRedeem")}>Cancel redemption</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
