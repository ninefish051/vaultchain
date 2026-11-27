"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Abi, Hex } from "viem";
import { useAccount, usePublicClient, useSignMessage } from "wagmi";
import { DEMO_CARDS, GRADERS, toUsd6, vaultCardNFTAbi, vaultMarketAbi, type Grader } from "@vaultchain/shared";
import { api } from "@/lib/api";
import { errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { gradeLabel, usd } from "@/lib/format";
import { KV, PageHeader, Spinner, TxStatus } from "@/components/ui";

function Sell() {
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const { deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const tx = useTx();

  const [mode, setMode] = useState<"vault" | "escrow">("escrow");
  const [tokenId, setTokenId] = useState("");
  const [cardKey, setCardKey] = useState<Hex | "">((params.get("cardKey") as Hex) ?? "");
  const [grader, setGrader] = useState<Grader>("PSA");
  const [cert, setCert] = useState("");
  const [psa, setPsa] = useState<Record<string, unknown>>();
  const [price, setPrice] = useState(0);
  const [acceptsSwap, setAcceptsSwap] = useState(true);
  const [swapWants, setSwapWants] = useState("");
  const [floor, setFloor] = useState(0);
  const [imageUrl, setImageUrl] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string }>();

  const cards = useQuery({ queryKey: ["cards", "all"], queryFn: () => api.cards() });
  const assets = useQuery({ queryKey: ["assets", address], queryFn: () => api.assets(address!), enabled: !!address });
  const asset = assets.data?.find((a) => a.tokenId === tokenId);
  const selectedKey = mode === "vault" ? asset?.cardKey : cardKey || undefined;
  const card = (cards.data ?? DEMO_CARDS).find((c) => c.cardKey === selectedKey);
  const fair = cards.data?.find((c) => c.cardKey === selectedKey)?.price?.fairValueUsd;

  async function verifyCert() {
    setPsa(undefined);
    try {
      setPsa(await api.psa(cert));
    } catch (e) {
      setMsg({ tone: "err", text: `PSA lookup: ${errorMessage(e)}` });
    }
  }

  async function submit() {
    if (!address) return;
    setMsg(undefined);
    try {
      if (mode === "vault") {
        if (!deployment || !asset) return;
        const hash = await tx.run(async (write) => {
          const ok = await publicClient!.readContract({ address: deployment.nft, abi: vaultCardNFTAbi, functionName: "isApprovedForAll", args: [address, deployment.market] });
          if (!ok) await write({ address: deployment.nft, abi: vaultCardNFTAbi as Abi, functionName: "setApprovalForAll", args: [deployment.market, true], label: "Approve marketplace" });
          return write({ address: deployment.market, abi: vaultMarketAbi as Abi, functionName: "list", args: [BigInt(asset.tokenId), toUsd6(price)], label: "Listing" });
        });
        if (hash) {
          await api.createListing(
            { type: "vault", grader: asset.grader, certNumber: asset.certNumber, cardKey: asset.cardKey, priceUsd: price, acceptsSwap, swapWants: swapWants || undefined, images: card ? [card.imageUrl] : [], floorUsd: floor || undefined },
            address,
            signMessageAsync,
          ).catch(() => undefined); // the indexer also picks up the Listed event
          setMsg({ tone: "ok", text: "Listed. Buyers can purchase it instantly." });
        }
      } else {
        if (!cardKey) return;
        await api.createListing(
          {
            type: "escrow",
            grader,
            certNumber: cert,
            cardKey,
            priceUsd: price,
            acceptsSwap,
            swapWants: swapWants || undefined,
            images: imageUrl ? [imageUrl] : card ? [card.imageUrl] : [],
            floorUsd: floor || undefined,
          },
          address,
          signMessageAsync,
        );
        setMsg({ tone: "ok", text: "Listed. When a buyer signs an order you'll find it under Orders → waiting for you." });
      }
    } catch (e) {
      setMsg({ tone: "err", text: errorMessage(e) });
    }
  }

  return (
    <div className="container-page max-w-3xl">
      <PageHeader title="Sell a graded card" sub="Only graded slabs (PSA, BGS, CGC). List a card that is already in the vault for instant sale, or a slab you still hold through escrow." />
      <div className="mt-6 flex gap-2">
        {(["escrow", "vault"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`rounded-lg px-3 py-1.5 text-sm ${mode === m ? "bg-gold text-ink-900" : "bg-ink-700"}`}>
            {m === "escrow" ? "A slab I hold" : "A vault NFT"}
          </button>
        ))}
      </div>

      <div className="panel mt-4 grid gap-4 p-5">
        {mode === "vault" ? (
          <div>
            <label className="label">Your vault card</label>
            {!isConnected ? (
              <p className="muted">Connect a wallet.</p>
            ) : assets.isLoading ? (
              <Spinner />
            ) : (
              <select className="input" value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
                <option value="">Select…</option>
                {(assets.data ?? []).filter((a) => a.custody === "InVault").map((a) => {
                  const c = (cards.data ?? DEMO_CARDS).find((x) => x.cardKey === a.cardKey);
                  return (
                    <option key={a.tokenId} value={a.tokenId}>
                      {c ? `${c.name} · ${gradeLabel(c)}` : a.cardKey.slice(0, 10)} · cert {a.certNumber}
                    </option>
                  );
                })}
              </select>
            )}
          </div>
        ) : (
          <>
            <div>
              <label className="label">Card type</label>
              <select className="input" value={cardKey} onChange={(e) => setCardKey(e.target.value as Hex)}>
                <option value="">Select…</option>
                {(cards.data ?? DEMO_CARDS).map((c) => (
                  <option key={c.cardKey} value={c.cardKey}>
                    {c.name} · {c.setName} #{c.number} · {gradeLabel(c)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-neutral-500">Missing a card? The vault adds new card types to the price catalogue on request.</p>
            </div>
            <div className="grid grid-cols-[110px_1fr_auto] gap-2">
              <div>
                <label className="label">Grader</label>
                <select className="input" value={grader} onChange={(e) => setGrader(e.target.value as Grader)}>
                  {GRADERS.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Certificate number</label>
                <input className="input" value={cert} onChange={(e) => setCert(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 12345678" />
              </div>
              {grader === "PSA" && (
                <button className="btn-ghost self-end" disabled={cert.length < 6} onClick={verifyCert}>
                  Verify
                </button>
              )}
            </div>
            {psa && (
              <div className="rounded-xl border border-up/40 bg-up/5 p-3 text-sm">
                PSA #{String(psa.certNumber)}: {String(psa.year ?? "")} {String(psa.brand ?? "")} {String(psa.subject ?? "")} #{String(psa.cardNumber ?? "")} · grade {String(psa.grade ?? "")}
              </div>
            )}
            <div>
              <label className="label">Photo URL (optional)</label>
              <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
            </div>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Price (USD)</label>
            <input className="input" type="number" min={1} value={price || ""} onChange={(e) => setPrice(Number(e.target.value))} />
            {fair !== undefined && (
              <p className="mt-1 text-xs text-neutral-400">
                Fair value {usd(fair)} · suggested {usd(fair * 0.98)}–{usd(fair * 1.05)}
                {price > 0 && Math.abs(price / fair - 1) > 0.4 && <span className="text-gold"> · far from fair value</span>}
              </p>
            )}
          </div>
          <div>
            <label className="label">Auto-accept floor (private, optional)</label>
            <input className="input" type="number" inputMode="decimal" min={0} value={floor || ""} onChange={(e) => setFloor(Number(e.target.value))} placeholder="e.g. 95% of your price" />
            <p className="mt-1 text-xs text-neutral-500">Your seller agent accepts offers at or above this and counters below it. Never shown to buyers.</p>
          </div>
          <div>
            <label className="label">Swaps</label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-gold" checked={acceptsSwap} onChange={(e) => setAcceptsSwap(e.target.checked)} /> Open to card-for-card swaps
            </label>
            {acceptsSwap && <input className="input mt-2" value={swapWants} onChange={(e) => setSwapWants(e.target.value)} placeholder="What would you take? e.g. any PSA 10 Lugia" />}
          </div>
        </div>

        {mode === "escrow" && price > 0 && (
          <div className="rounded-xl border border-ink-600 p-3">
            <KV k="Platform fee" v="1% on completion" />
            <KV k="Your deposit" v="Locked when a buyer's order is signed; returned after inspection passes" />
          </div>
        )}

        <button
          className="btn-gold"
          disabled={!isConnected || !price || (mode === "vault" ? !asset || !deployment : !cardKey || cert.length < 6)}
          onClick={submit}
        >
          List for {usd(price || undefined)}
        </button>
        <TxStatus state={tx.state} />
        {msg && <div className={`text-sm ${msg.tone === "ok" ? "text-up" : "text-down"}`}>{msg.text}</div>}
      </div>
    </div>
  );
}

export default function SellPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Sell />
    </Suspense>
  );
}
