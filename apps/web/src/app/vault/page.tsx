"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { keccak256, toBytes, type Abi, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { DEMO_CARDS, GRADERS, swapEscrowAbi, vaultCardNFTAbi, vaultEscrowAbi, type Grader } from "@vaultchain/shared";
import { api } from "@/lib/api";
import { errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { gradeLabel, short, usd } from "@/lib/format";
import { Badge, Empty, PageHeader, Spinner, TxStatus } from "@/components/ui";

/** Vault back office: intake (register + mint), inspection, delivery, redemption, disputes. Requires VAULT_ROLE / ARBITER_ROLE. */
export default function VaultAdmin() {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const { signMessageAsync } = useSignMessage();
  const tx = useTx();
  const queue = useQuery({ queryKey: ["vault-queue"], queryFn: () => api.vaultQueue(), refetchInterval: 30_000 });
  const cards = useQuery({ queryKey: ["cards", "all"], queryFn: () => api.cards() });

  const [grader, setGrader] = useState<Grader>("PSA");
  const [cert, setCert] = useState("");
  const [cardKey, setCardKey] = useState<Hex | "">("");
  const [owner, setOwner] = useState("");
  const [location, setLocation] = useState("");
  const [report, setReport] = useState("");
  const [award, setAward] = useState(0);
  const [msg, setMsg] = useState<string>();

  if (!deployment) return <div className="container-page pt-10"><Empty title="Connect the vault operator wallet on a network where VaultChain is deployed" /></div>;
  const d = deployment;

  async function intake() {
    if (!address || !cardKey) return;
    setMsg(undefined);
    try {
      const reg = await api.registerSlab({ grader, certNumber: cert, cardKey, location }, address, signMessageAsync);
      await tx.run((w) =>
        w({ address: d.nft, abi: vaultCardNFTAbi as Abi, functionName: "mint", args: [owner || address, reg.slabId, cardKey, reg.metadataHash], label: "Minting vault NFT" }),
      );
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  const reportHash = () => keccak256(toBytes(report || `inspection:${Date.now()}`));
  const inspectOrder = (id: Hex, passed: boolean) =>
    tx.run((w) => w({ address: d.escrow, abi: vaultEscrowAbi as Abi, functionName: "submitInspection", args: [id, passed, reportHash()], label: passed ? "Passing inspection" : "Failing inspection" })).then(() => queue.refetch());
  const inspectLeg = (id: Hex, side: number, passed: boolean) =>
    tx.run((w) => w({ address: d.swapEscrow, abi: swapEscrowAbi as Abi, functionName: "submitInspection", args: [id, side, passed, reportHash()], label: "Recording swap inspection" })).then(() => queue.refetch());

  return (
    <div className="container-page">
      <PageHeader title="Vault operations" sub="Only wallets holding VAULT_ROLE (and ARBITER_ROLE for disputes) can execute these actions. Reports and photos are hashed on-chain." />
      <TxStatus state={tx.state} />
      {msg && <div className="mt-2 text-sm text-down">{msg}</div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="font-semibold">Intake: register and mint a slab</div>
          <div className="mt-3 grid gap-3">
            <select className="input" value={cardKey} onChange={(e) => setCardKey(e.target.value as Hex)}>
              <option value="">Card type…</option>
              {(cards.data ?? DEMO_CARDS).map((c) => (
                <option key={c.cardKey} value={c.cardKey}>
                  {c.name} · {c.setName} · {gradeLabel(c)}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <select className="input" value={grader} onChange={(e) => setGrader(e.target.value as Grader)}>
                {GRADERS.map((g) => <option key={g}>{g}</option>)}
              </select>
              <input className="input" placeholder="Certificate number" value={cert} onChange={(e) => setCert(e.target.value)} />
            </div>
            <input className="input font-mono" placeholder="Owner wallet (default: you)" value={owner} onChange={(e) => setOwner(e.target.value)} />
            <input className="input" placeholder="Shelf / location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <button className="btn-gold" disabled={!cardKey || cert.length < 6} onClick={intake}>Register &amp; mint NFT</button>
          </div>
        </div>

        <div className="panel p-5">
          <div className="font-semibold">Inspection report</div>
          <p className="muted mt-1">Paste the report link (photos, video, notes on IPFS/S3). Its hash is recorded with each decision.</p>
          <input className="input mt-3" placeholder="ipfs://… or https://…" value={report} onChange={(e) => setReport(e.target.value)} />
          <div className="mt-4 font-semibold">Arbiter award</div>
          <input className="input mt-2" type="number" min={0} value={award} onChange={(e) => setAward(Number(e.target.value))} />
          <p className="mt-1 text-xs text-neutral-500">Paid to the buyer (orders) or the innocent side (swaps) from the deposit of the party at fault.</p>
        </div>
      </div>

      {queue.isLoading ? (
        <Spinner />
      ) : queue.error ? (
        <div className="mt-8"><Empty title="Queue unavailable">The API needs a database and indexer to list pending work.</Empty></div>
      ) : (
        <div className="mt-8 grid gap-6">
          <div className="panel p-5">
            <div className="font-semibold">Orders to inspect ({queue.data!.inspectOrders.length})</div>
            {queue.data!.inspectOrders.map((o) => (
              <div key={o.orderId} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-700 pt-3 text-sm">
                <span className="font-mono">{short(o.orderId, 8)} · {usd(o.priceUsd)} · seller {short(o.seller)}</span>
                <span className="flex gap-2">
                  <button className="btn-gold py-1.5" onClick={() => inspectOrder(o.orderId, true)}>Pass</button>
                  <button className="btn-danger py-1.5" onClick={() => inspectOrder(o.orderId, false)}>Fail</button>
                </span>
              </div>
            ))}
          </div>

          <div className="panel p-5">
            <div className="font-semibold">Swaps to inspect ({queue.data!.inspectSwaps.length})</div>
            {queue.data!.inspectSwaps.map((s) => (
              <div key={s.swapId} className="mt-3 border-t border-ink-700 pt-3 text-sm">
                <div className="font-mono">{short(s.swapId, 8)}</div>
                {[0, 1].map((side) => (
                  <div key={side} className="mt-2 flex items-center justify-between gap-2">
                    <span>Side {side === 0 ? "A" : "B"} <Badge>{s.legState[side]}</Badge></span>
                    {s.legState[side] === "Shipped" && (
                      <span className="flex gap-2">
                        <button className="btn-gold py-1.5" onClick={() => inspectLeg(s.swapId, side, true)}>Pass</button>
                        <button className="btn-danger py-1.5" onClick={() => inspectLeg(s.swapId, side, false)}>Fail</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="panel p-5">
            <div className="font-semibold">Outbound deliveries ({queue.data!.deliveries.length})</div>
            {queue.data!.deliveries.map((x) => {
              const isOrder = "orderId" in x;
              const id = isOrder ? x.orderId : x.swapId;
              return (
                <div key={id} className="mt-3 flex items-center justify-between border-t border-ink-700 pt-3 text-sm">
                  <span className="font-mono">{isOrder ? "order" : "swap"} {short(id, 8)}</span>
                  <button
                    className="btn-ghost py-1.5"
                    onClick={() => tx.run((w) => w({ address: isOrder ? d.escrow : d.swapEscrow, abi: (isOrder ? vaultEscrowAbi : swapEscrowAbi) as Abi, functionName: "confirmDelivered", args: [id], label: "Confirming delivery" }))}
                  >
                    Confirm delivered
                  </button>
                </div>
              );
            })}
          </div>

          <div className="panel p-5">
            <div className="font-semibold">Disputes ({queue.data!.disputes.length})</div>
            {queue.data!.disputes.map((x) => {
              const isOrder = "orderId" in x;
              const id = isOrder ? x.orderId : x.swapId;
              const award6 = BigInt(Math.round(award * 100)) * 10_000n;
              return (
                <div key={id} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-700 pt-3 text-sm">
                  <span className="font-mono">{isOrder ? "order" : "swap"} {short(id, 8)}</span>
                  {isOrder ? (
                    <button className="btn-ghost py-1.5" onClick={() => tx.run((w) => w({ address: d.escrow, abi: vaultEscrowAbi as Abi, functionName: "resolveDispute", args: [id, award6], label: "Resolving" }))}>
                      Refund · award {usd(award)} to buyer
                    </button>
                  ) : (
                    <span className="flex gap-2">
                      {[0, 1, 2].map((f) => (
                        <button key={f} className="btn-ghost py-1.5" onClick={() => tx.run((w) => w({ address: d.swapEscrow, abi: swapEscrowAbi as Abi, functionName: "resolveDispute", args: [id, f, f === 0 ? 0n : award6], label: "Resolving" }))}>
                          {f === 0 ? "No fault" : `Side ${f === 1 ? "A" : "B"} at fault`}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="panel p-5">
            <div className="font-semibold">Buyer defaults: return to seller ({queue.data!.returns.length})</div>
            {queue.data!.returns.map((o) => (
              <div key={o.orderId} className="mt-3 flex items-center justify-between border-t border-ink-700 pt-3 text-sm">
                <span className="font-mono">{short(o.orderId, 8)} · {usd(o.priceUsd)}</span>
                <button className="btn-ghost py-1.5" onClick={() => tx.run((w) => w({ address: d.escrow, abi: vaultEscrowAbi as Abi, functionName: "markReturned", args: [o.orderId], label: "Marking returned" }))}>
                  Mark returned
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
