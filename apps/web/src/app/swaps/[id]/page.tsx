"use client";

import Link from "next/link";

import { PartyPopper } from "lucide-react";

import { use, useState } from "react";
import { keccak256, toBytes, type Abi, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { SWAP_STATUS, fromUsd6, swapEscrowAbi, vaultCardNFTAbi } from "@vaultchain/shared";
import { ensureAllowance, useDeployment, useTx } from "@/lib/contracts";
import { short, timeLeft, usd } from "@/lib/format";
import { HspPay } from "@/components/HspPay";
import { ShippingForm, VaultAddress } from "@/components/ShippingForm";
import { Timeline } from "@/components/Timeline";
import { Credits } from "@/components/Credits";
import { Badge, Empty, KV, PageHeader, Spinner, TxStatus } from "@/components/ui";

const STEPS = ["Signed", "Deposits locked", "Cards at the vault", "Inspected & swapped"];
const STEP_OF: Record<string, number> = { Signed: 0, Locked: 1, Inspecting: 2, Disputed: 2, AwaitingDelivery: 3, Completed: 4 };
const FAILED: Record<string, string> = {
  Defaulted: "One side did not ship in time and compensated the other from its deposit. Top-up and vaulted NFTs were returned.",
  Cancelled: "The swap was cancelled and everything returned.",
  Refunded: "An arbiter settled the dispute; cards and funds were returned.",
  Disputed: "An inspection failed or timed out. An arbiter will settle it.",
};
const LEG = ["Waiting for shipment", "Shipped, awaiting inspection", "Ready"];

export default function SwapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const swapId = id as Hex;
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const publicClient = usePublicClient();
  const tx = useTx();
  const [tracking, setTracking] = useState("");
  const [hspActive, setHspActive] = useState(false);

  const { data: s, refetch, isLoading } = useReadContract({
    address: deployment?.swapEscrow,
    abi: swapEscrowAbi,
    functionName: "getSwap",
    args: [swapId],
    query: { enabled: !!deployment && /^0x[0-9a-fA-F]{64}$/.test(id) },
  });
  const { data: due } = useReadContract({
    address: deployment?.swapEscrow,
    abi: swapEscrowAbi,
    functionName: "expectedPayment",
    args: [swapId, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!deployment && !!address },
  });

  if (!deployment) return <div className="container-page pt-10"><Empty title="Connect to a network where VaultChain is deployed" /></div>;
  if (isLoading) return <div className="container-page"><Spinner /></div>;
  if (!s || s.status === 0) return <div className="container-page pt-10"><Empty title="Swap not found on this network" /></div>;

  const status = SWAP_STATUS[s.status]!;
  const mySide = s.legs[0].owner.toLowerCase() === address?.toLowerCase() ? 0 : s.legs[1].owner.toLowerCase() === address?.toLowerCase() ? 1 : -1;
  const deadline = s.deadline > 0n ? new Date(Number(s.deadline) * 1000).toISOString() : undefined;
  const expired = deadline ? new Date(deadline).getTime() < Date.now() : false;
  const call = (functionName: string, args: unknown[], label: string) =>
    tx.run((w) => w({ address: deployment.swapEscrow, abi: swapEscrowAbi as Abi, functionName, args, label })).then(() => refetch());

  async function fund() {
    if (!address || !due || mySide < 0) return;
    await tx.run(async (w) => {
      if (s!.legs[mySide as 0 | 1]!.kind === 1) {
        const ok = await publicClient!.readContract({ address: deployment!.nft, abi: vaultCardNFTAbi, functionName: "isApprovedForAll", args: [address, deployment!.swapEscrow] });
        if (!ok) await w({ address: deployment!.nft, abi: vaultCardNFTAbi as Abi, functionName: "setApprovalForAll", args: [deployment!.swapEscrow, true], label: "Approve NFT for escrow" });
      }
      await ensureAllowance(w, publicClient!, deployment!.usdc, address, deployment!.swapEscrow, due);
      return w({ address: deployment!.swapEscrow, abi: swapEscrowAbi as Abi, functionName: "fund", args: [swapId], label: "Locking deposit" });
    });
    refetch();
  }

  return (
    <div className="container-page">
      <PageHeader title={`Swap ${short(swapId, 6)}`} back={{ href: "/orders", label: "Orders" }} />
      <div className="mt-6">
        <Timeline steps={STEPS} current={STEP_OF[status] ?? 0} failed={FAILED[status]} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Terms</div>
            <Badge tone="blue">{status}</Badge>
          </div>
          {[0, 1].map((i) => {
            const leg = s.legs[i]!;
            return (
              <div key={i} className="mt-3 rounded-xl border border-ink-600 p-3">
                <div className="text-sm font-medium">
                  Side {i === 0 ? "A" : "B"} {mySide === i && "(you)"} · <span className="font-mono">{short(leg.owner)}</span>
                </div>
                <div className="mt-1 text-xs text-neutral-400">
                  {leg.kind === 1 ? "Vault NFT" : "Physical slab"} · fair at signing {usd(fromUsd6(s.refValueUsd[i]!))} · counterparty {leg.delivery === 1 ? "keeps it vaulted" : "gets it shipped"}
                </div>
                <div className="mt-1 text-xs">
                  {s.funded[i] ? "Deposit locked ✓" : "Deposit pending"} · {LEG[s.legState[i]!]}
                </div>
              </div>
            );
          })}
          <div className="mt-3">
            <KV k="Deposit (each side)" v={usd(fromUsd6(s.depositUsd), true)} />
            <KV k="Top-up" v={s.topUpFrom === 0 ? "none" : `${usd(fromUsd6(s.topUpUsd), true)} from side ${s.topUpFrom === 1 ? "A" : "B"}`} />
            <KV k="Current deadline" v={deadline ? `${new Date(deadline).toLocaleString()} (${timeLeft(deadline)})` : "—"} />
          </div>
        </div>

        <div className="panel p-5">
          <div className="font-semibold">Your next step</div>
          <div className="mt-3 grid gap-3">
            {due !== undefined && due > 0n && (
              <>
                <p className="text-sm text-neutral-300">
                  Lock <b className="text-white">{usd(fromUsd6(due), true)}</b> (deposit{s.topUpFrom === mySide + 1 ? " + top-up" : ""})
                  {mySide >= 0 && s.legs[mySide as 0 | 1]!.kind === 1 && " and move your NFT into escrow"}.
                </p>
                {!hspActive && (
                  <button className="btn-gold" onClick={fund} disabled={tx.state.status === "pending"}>
                    Lock from wallet
                  </button>
                )}
                <HspPay target="swap" id={swapId} onActiveChange={setHspActive} />
              </>
            )}
            {status === "Locked" && mySide >= 0 && s.legState[mySide as 0 | 1] === 0 && !expired && (
              <div className="grid gap-2">
                <VaultAddress />
                <p className="text-sm text-neutral-300">Ship it, then add the tracking number.</p>
                <input className="input" placeholder="Courier + tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                <button className="btn-gold" disabled={!tracking} onClick={() => call("markShipped", [swapId, keccak256(toBytes(tracking.trim()))], "Marking shipped")}>
                  Mark as shipped
                </button>
              </div>
            )}
            {status === "Completed" && (
              <div className="flex items-center gap-3 rounded-xl border border-up/30 bg-up/10 p-4 text-sm">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-up/20 text-up">
                  <PartyPopper className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-semibold text-white">Swap done</div>
                  <Link href="/assets" className="text-gold underline">See my cards</Link>
                </div>
              </div>
            )}
            {mySide >= 0 && s.legs[(1 - mySide) as 0 | 1].delivery === 0 && !["Cancelled", "Defaulted", "Refunded", "Completed"].includes(status) && (
              <ShippingForm target="swap" targetId={swapId} title="Where should the vault ship the card you receive?" />
            )}
            {expired && status === "Signed" && <button className="btn-danger" onClick={() => call("cancelUnfunded", [swapId], "Cancelling")}>Cancel and refund</button>}
            {expired && status === "Locked" && <button className="btn-danger" onClick={() => call("claimShipDefault", [swapId], "Settling")}>Settle: a side did not ship</button>}
            {expired && status === "Inspecting" && <button className="btn-danger" onClick={() => call("escalateInspectionTimeout", [swapId], "Escalating")}>Escalate: inspection timed out</button>}
            <TxStatus state={tx.state} />
          </div>
        </div>
      </div>
      <Credits />
    </div>
  );
}
