"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useSignMessage, useSignTypedData } from "wagmi";
import { fromUsd6, swapEscrowAbi, vaultEscrowAbi, type OrderTermsMessage, type SwapTermsMessage } from "@vaultchain/shared";
import { api, type Proposal } from "@/lib/api";
import { errorMessage, useDeployment, useTx } from "@/lib/contracts";
import { short, timeLeft, usd } from "@/lib/format";
import { fromJson, orderTypedData, swapTypedData } from "@/lib/terms";
import { Credits } from "@/components/Credits";
import { Offers } from "@/components/Offers";
import { Badge, Empty, PageHeader, Spinner, TxStatus } from "@/components/ui";

function ProposalRow({ p, me }: { p: Proposal; me: Address }) {
  const { chainId, deployment } = useDeployment();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const tx = useTx();
  const [err, setErr] = useState<string>();
  const incoming = p.counterparty.toLowerCase() === me.toLowerCase();

  const summary =
    p.kind === "order"
      ? (() => {
          const t = fromJson<OrderTermsMessage>(p.terms);
          return `Escrow sale at ${usd(fromUsd6(t.priceUsd))} · ${t.fulfillment === 1 ? "keep in vault" : "ship to buyer"}`;
        })()
      : (() => {
          const t = fromJson<SwapTermsMessage>(p.terms);
          const top = fromUsd6(t.topUpUsd);
          return `Swap · ${top > 0 ? `${t.topUpFrom === 1 ? "proposer" : "you"} add ${usd(top)}` : "even"} · legs: ${t.a.kind ? "vault" : "physical"} ⇄ ${t.b.kind ? "vault" : "physical"}`;
        })();

  /** Countersign the same EIP-712 terms and create the order/swap on-chain with both signatures. */
  async function accept() {
    if (!deployment) return;
    setErr(undefined);
    try {
      if (p.kind === "order") {
        const t = fromJson<OrderTermsMessage>(p.terms);
        const mine = await signTypedDataAsync(orderTypedData(chainId, deployment.escrow, t));
        const [buyerSig, sellerSig] = t.buyer.toLowerCase() === me.toLowerCase() ? [mine, p.proposerSig] : [p.proposerSig, mine];
        await tx.run((w) => w({ address: deployment.escrow, abi: vaultEscrowAbi as Abi, functionName: "createOrder", args: [t, buyerSig, sellerSig], label: "Creating escrow order" }));
      } else {
        const t = fromJson<SwapTermsMessage>(p.terms);
        const mine = await signTypedDataAsync(swapTypedData(chainId, deployment.swapEscrow, t));
        const [sigA, sigB] = t.a.owner.toLowerCase() === me.toLowerCase() ? [mine, p.proposerSig] : [p.proposerSig, mine];
        await tx.run((w) => w({ address: deployment.swapEscrow, abi: swapEscrowAbi as Abi, functionName: "createSwap", args: [t, sigA, sigB], label: "Creating swap" }));
      }
      await api.setProposalStatus(p.id, "accepted", me, signMessageAsync);
      qc.invalidateQueries();
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  async function cancel() {
    try {
      await api.setProposalStatus(p.id, "cancelled", me, signMessageAsync);
      qc.invalidateQueries({ queryKey: ["proposals"] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Badge tone={p.kind === "swap" ? "blue" : "gold"}>{p.kind}</Badge> {summary}
        </div>
        <div className="mt-0.5 text-xs text-neutral-500">
          {incoming ? `From ${short(p.proposer)}` : `To ${short(p.counterparty)}`} · {new Date(p.createdAt).toLocaleString()}
        </div>
        <TxStatus state={tx.state} />
        {err && <div className="mt-1 text-xs text-down">{err}</div>}
      </div>
      <div className="flex gap-2">
        {incoming && p.status === "open" && (
          <button className="btn-gold" onClick={accept} disabled={!deployment}>
            Countersign &amp; create
          </button>
        )}
        {p.status === "open" && (
          <button className="btn-ghost" onClick={cancel}>
            {incoming ? "Decline" : "Withdraw"}
          </button>
        )}
        {p.status !== "open" && <Badge>{p.status}</Badge>}
      </div>
    </div>
  );
}

export default function OrdersPage() {
  const { address } = useAccount();
  const proposals = useQuery({ queryKey: ["proposals", address], queryFn: () => api.proposals(address!), enabled: !!address });
  const orders = useQuery({ queryKey: ["orders", address], queryFn: () => api.orders(address!), enabled: !!address });
  const swaps = useQuery({ queryKey: ["swaps", address], queryFn: () => api.swaps(address!), enabled: !!address });
  const [lookup, setLookup] = useState("");

  if (!address)
    return (
      <div className="container-page">
        <PageHeader title="Orders" />
        <div className="mt-6"><Empty title="Connect a wallet to see your orders and swaps" /></div>
      </div>
    );

  const open = (proposals.data ?? []).filter((p) => p.status === "open");
  return (
    <div className="container-page">
      <PageHeader title="Orders & swaps" sub="Everything here settles through the escrow contracts. Status and deadlines are read from the chain." />
      <Credits />

      <h2 className="mt-10 text-lg font-semibold">Waiting for signatures</h2>
      <div className="panel mt-3 divide-y divide-ink-700">
        {proposals.isLoading ? <Spinner /> : open.length === 0 ? <div className="px-4 py-6 text-sm text-neutral-500">Nothing waiting.</div> : open.map((p) => <ProposalRow key={p.id} p={p} me={address} />)}
      </div>

      <Offers me={address} />

      <h2 className="mt-10 text-lg font-semibold">Escrow orders</h2>
      <div className="panel mt-3 divide-y divide-ink-700">
        {orders.isLoading ? (
          <Spinner />
        ) : (orders.data ?? []).length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">No orders yet.</div>
        ) : (
          orders.data!.map((o) => (
            <Link key={o.orderId} href={`/orders/${o.orderId}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-700/50">
              <div className="text-sm">
                <div className="font-medium">
                  {o.buyer.toLowerCase() === address.toLowerCase() ? "Buying" : "Selling"} · {usd(o.priceUsd)}
                </div>
                <div className="font-mono text-xs text-neutral-500">{short(o.orderId, 8)}</div>
              </div>
              <div className="text-right text-sm">
                <Badge tone="gold">{o.status}</Badge>
                <div className="mt-1 text-xs text-neutral-400">{o.deadline ? `due in ${timeLeft(o.deadline)}` : ""}</div>
              </div>
            </Link>
          ))
        )}
      </div>

      <h2 className="mt-10 text-lg font-semibold">Swaps</h2>
      <div className="panel mt-3 divide-y divide-ink-700">
        {swaps.isLoading ? (
          <Spinner />
        ) : (swaps.data ?? []).length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">No swaps yet.</div>
        ) : (
          swaps.data!.map((s) => (
            <Link key={s.swapId} href={`/swaps/${s.swapId}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-700/50">
              <div className="text-sm">
                <div className="font-medium">
                  Swap with {short(s.partyA.toLowerCase() === address.toLowerCase() ? s.partyB : s.partyA)} {s.topUpUsd > 0 && `· top-up ${usd(s.topUpUsd)}`}
                </div>
                <div className="font-mono text-xs text-neutral-500">{short(s.swapId, 8)}</div>
              </div>
              <Badge tone="blue">{s.status}</Badge>
            </Link>
          ))
        )}
      </div>

      <div className="mt-10 flex gap-2">
        <input className="input max-w-md font-mono" placeholder="Open an order or swap by id (0x…)" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        <Link className="btn-ghost" href={`/orders/${lookup as Hex}`}>Order</Link>
        <Link className="btn-ghost" href={`/swaps/${lookup as Hex}`}>Swap</Link>
      </div>
    </div>
  );
}
