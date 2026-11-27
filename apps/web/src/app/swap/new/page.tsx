"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import type { Abi, Hex } from "viem";
import { useAccount, usePublicClient, useSignMessage, useSignTypedData } from "wagmi";
import { DEMO_CARDS, GRADERS, slabIdOf, toUsd6, vaultCardNFTAbi, vaultSwapAbi, type Grader } from "@vaultchain/shared";
import { api, type SwapQuote } from "@/lib/api";
import { ensureAllowance, errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { bps, cardTitle, gradeLabel, usd } from "@/lib/format";
import { buildLeg, buildSwapTerms, swapTypedData, toJson } from "@/lib/terms";
import { CardImage } from "@/components/CardTile";
import { KV, PageHeader, Spinner, TxStatus } from "@/components/ui";

function NewSwap() {
  const params = useSearchParams();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { chainId, deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const tx = useTx();

  const [wantId, setWantId] = useState(params.get("want") ?? "");
  const [source, setSource] = useState<"vault" | "physical">("vault");
  const [myTokenId, setMyTokenId] = useState("");
  const [grader, setGrader] = useState<Grader>("PSA");
  const [cert, setCert] = useState("");
  const [myCardKey, setMyCardKey] = useState<Hex | "">("");
  const [keepInVault, setKeepInVault] = useState(true);
  const [quote, setQuote] = useState<SwapQuote>();
  const [topUp, setTopUp] = useState(0);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string }>();

  const swappable = useQuery({ queryKey: ["listings", "swap"], queryFn: () => api.listings({ acceptsSwap: "true" }) });
  const assets = useQuery({ queryKey: ["assets", address], queryFn: () => api.assets(address!), enabled: !!address });
  const cards = useQuery({ queryKey: ["cards", "all"], queryFn: () => api.cards() });

  const want = swappable.data?.find((l) => l.id === wantId);
  const myAsset = assets.data?.find((a) => a.tokenId === myTokenId);
  const mine = source === "vault" ? myAsset && { cardKey: myAsset.cardKey, slabId: myAsset.slabId, certNumber: myAsset.certNumber } : myCardKey && cert ? { cardKey: myCardKey, slabId: slabIdOf(grader, cert), certNumber: cert } : undefined;
  const myCard = useMemo(() => (cards.data ?? DEMO_CARDS).find((c) => c.cardKey === mine?.cardKey), [cards.data, mine?.cardKey]);

  useEffect(() => {
    if (!mine?.cardKey || !want) {
      setQuote(undefined);
      return;
    }
    let live = true;
    api
      .quoteSwap(mine.cardKey, want.cardKey)
      .then((q) => {
        if (!live) return;
        setQuote(q);
        setTopUp(q.topUpUsd);
      })
      .catch((e) => live && setMsg({ tone: "err", text: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [mine?.cardKey, want]);

  const bothVaulted = source === "vault" && want?.type === "vault";
  const iPay = quote?.topUpFrom === 1;

  async function submit() {
    if (!address || !deployment || !want || !mine || !quote) return;
    setMsg(undefined);
    try {
      if (bothVaulted && myAsset && want.tokenId) {
        // Atomic NFT ↔ NFT offer on VaultSwap; the counterparty accepts on-chain.
        await tx.run(async (write) => {
          const approved = await publicClient!.readContract({ address: deployment.nft, abi: vaultCardNFTAbi, functionName: "isApprovedForAll", args: [address, deployment.vaultSwap] });
          if (!approved) await write({ address: deployment.nft, abi: vaultCardNFTAbi as Abi, functionName: "setApprovalForAll", args: [deployment.vaultSwap, true], label: "Approve NFT for swaps" });
          // top-up (if we pay it) + the flat per-side fee, both pulled when the offer is accepted
          await ensureAllowance(write, publicClient!, deployment.usdc, address, deployment.vaultSwap, toUsd6((iPay ? topUp : 0) + 5));
          const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
          return write({
            address: deployment.vaultSwap,
            abi: vaultSwapAbi as Abi,
            functionName: "createOffer",
            args: [BigInt(myAsset.tokenId), BigInt(want.tokenId!), "0x" + "0".repeat(64), toUsd6(topUp), iPay, expiry],
            label: "Creating swap offer",
          });
        });
        return;
      }
      const a = buildLeg({ owner: address, ...mine, vaulted: source === "vault", counterpartyKeepsInVault: true });
      const b = buildLeg({ owner: want.seller, cardKey: want.cardKey, slabId: want.slabId, certNumber: want.certNumber, vaulted: want.type === "vault", counterpartyKeepsInVault: keepInVault });
      const terms = buildSwapTerms(a, b, topUp, quote.topUpFrom === 0 ? 0 : (quote.topUpFrom as 1 | 2));
      const sig = await signTypedDataAsync(swapTypedData(chainId, deployment.swapEscrow, terms));
      await api.createProposal({ kind: "swap", counterparty: want.seller, terms: toJson(terms), proposerSig: sig }, address, signMessageAsync);
      setMsg({ tone: "ok", text: "Swap proposal signed and sent. When the other side countersigns, both lock deposits from Orders." });
      setTimeout(() => router.push("/orders"), 1500);
    } catch (e) {
      setMsg({ tone: "err", text: errorMessage(e) });
    }
  }

  return (
    <div className="container-page">
      <PageHeader title="Propose a swap" back={{ href: "/swap", label: "Swap" }} />
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_auto_1fr]">
        {/* my side */}
        <div className="panel p-5">
          <div className="label">You give</div>
          <div className="mb-3 flex gap-2">
            {(["vault", "physical"] as const).map((s) => (
              <button key={s} onClick={() => setSource(s)} className={`rounded-lg px-3 py-1.5 text-sm ${source === s ? "bg-gold text-ink-900" : "bg-ink-700"}`}>
                {s === "vault" ? "A vault NFT" : "A slab I hold"}
              </button>
            ))}
          </div>
          {source === "vault" ? (
            !isConnected ? (
              <p className="muted">Connect a wallet to see your vault cards.</p>
            ) : (
              <select className="input" value={myTokenId} onChange={(e) => setMyTokenId(e.target.value)}>
                <option value="">Select a card…</option>
                {(assets.data ?? []).filter((x) => x.custody === "InVault").map((x) => {
                  const c = (cards.data ?? DEMO_CARDS).find((cc) => cc.cardKey === x.cardKey);
                  return (
                    <option key={x.tokenId} value={x.tokenId}>
                      {c ? `${c.name} ${gradeLabel(c)}` : x.cardKey.slice(0, 10)} · cert {x.certNumber}
                    </option>
                  );
                })}
              </select>
            )
          ) : (
            <div className="grid gap-3">
              <select className="input" value={myCardKey} onChange={(e) => setMyCardKey(e.target.value as Hex)}>
                <option value="">Card type…</option>
                {(cards.data ?? DEMO_CARDS).map((c) => (
                  <option key={c.cardKey} value={c.cardKey}>
                    {c.name} · {c.setName} · {gradeLabel(c)}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <select className="input" value={grader} onChange={(e) => setGrader(e.target.value as Grader)}>
                  {GRADERS.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
                <input className="input" placeholder="Certificate number" value={cert} onChange={(e) => setCert(e.target.value)} />
              </div>
            </div>
          )}
          {myCard && (
            <div className="mt-4 flex gap-3">
              <CardImage src={myCard.imageUrl} alt="" className="h-28 w-20 shrink-0" />
              <div className="text-sm">
                <div className="font-medium">{cardTitle(myCard)}</div>
                <div className="text-neutral-400">{gradeLabel(myCard)}</div>
                <div className="mt-2">Fair {usd(quote?.fairValueA)}</div>
              </div>
            </div>
          )}
        </div>

        <ArrowLeftRight className="mx-auto mt-16 hidden h-6 w-6 text-gold lg:block" />

        {/* their side */}
        <div className="panel p-5">
          <div className="label">You receive</div>
          {swappable.isLoading ? (
            <Spinner />
          ) : (
            <select className="input" value={wantId} onChange={(e) => setWantId(e.target.value)}>
              <option value="">Select a card open to swaps…</option>
              {(swappable.data ?? []).filter((l) => l.seller.toLowerCase() !== address?.toLowerCase()).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.card.name} {gradeLabel(l.card)} · {l.type} · ask {usd(l.priceUsd)}
                </option>
              ))}
            </select>
          )}
          {want && (
            <div className="mt-4 flex gap-3">
              <CardImage src={want.card.imageUrl} alt="" className="h-28 w-20 shrink-0" />
              <div className="text-sm">
                <div className="font-medium">{cardTitle(want.card)}</div>
                <div className="text-neutral-400">{gradeLabel(want.card)} · cert {want.certNumber}</div>
                <div className="mt-2">Fair {usd(quote?.fairValueB ?? want.price?.fairValueUsd)}</div>
                {want.swapWants && <div className="mt-1 text-xs text-neutral-500">Wants: {want.swapWants}</div>}
              </div>
            </div>
          )}
          {want && !bothVaulted && (
            <div className="mt-4">
              <label className="label">When it passes inspection</label>
              <select className="input" value={keepInVault ? "vault" : "ship"} onChange={(e) => setKeepInVault(e.target.value === "vault")}>
                <option value="vault">Keep in vault (mint NFT to me)</option>
                <option value="ship">Ship to me</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {quote && want && mine && (
        <div className="panel mx-auto mt-6 max-w-2xl p-5">
          <div className="font-semibold">{bothVaulted ? "Instant vault swap" : "Escrowed swap"}</div>
          <div className="mt-3">
            <label className="label">Top-up (USD) — {quote.topUpFrom === 0 ? "even" : iPay ? "you pay" : "they pay"}</label>
            <input className="input" type="number" min={0} value={topUp} onChange={(e) => setTopUp(Number(e.target.value))} />
            <p className="mt-1 text-xs text-neutral-500">Suggested from fair values: {usd(quote.topUpUsd, true)}. The escrow rejects swaps whose sides differ by more than 10%.</p>
          </div>
          {!bothVaulted && (
            <div className="mt-3 rounded-xl border border-ink-600 p-3">
              <KV k="Deposit per side" v={`${usd(quote.depositUsd, true)} (${bps(quote.depositBps)})`} />
              <KV k="You lock" v={usd(quote.depositUsd + (iPay ? topUp : 0), true)} />
              <KV k="Fee" v="1% of the card you receive" />
            </div>
          )}
          <button className="btn-gold mt-4 w-full" disabled={!isConnected || !deployment} onClick={submit}>
            {bothVaulted ? "Create swap offer" : "Sign swap proposal"}
          </button>
          <TxStatus state={tx.state} />
          {msg && <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-up" : "text-down"}`}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}

export default function NewSwapPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewSwap />
    </Suspense>
  );
}
