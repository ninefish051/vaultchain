"use client";

import { use, useState } from "react";
import { keccak256, toBytes, type Abi, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { ORDER_STATUS, fromUsd6, vaultEscrowAbi } from "@vaultchain/shared";
import { ensureAllowance, useDeployment, useTx } from "@/lib/contracts";
import { short, timeLeft, usd } from "@/lib/format";
import { HspPay } from "@/components/HspPay";
import { Timeline } from "@/components/Timeline";
import { Credits } from "@/components/Credits";
import { Badge, Empty, KV, PageHeader, Spinner, TxStatus } from "@/components/ui";

const STEPS = ["Signed", "Deposits locked", "At the vault", "Inspection passed", "Paid", "Delivered"];
const STEP_OF: Record<string, number> = { Signed: 0, Locked: 1, Inspecting: 2, PaymentWindow: 3, AwaitingDelivery: 5, Completed: 6, Disputed: 2 };
const FAILED: Record<string, string> = {
  BuyerDefault: "The buyer missed the payment deadline. The seller was compensated from the buyer's deposit; the card is returned or bought out by VaultChain.",
  SellerDefault: "The seller never shipped. The buyer was compensated from the seller's deposit.",
  Cancelled: "Deposits were not completed in time. Any deposit paid was returned.",
  Refunded: "The dispute was resolved by the arbiter and deposits were settled.",
  Returned: "The card was returned to the seller after the buyer's default.",
  BoughtOut: "VaultChain bought the card at the agreed price after the buyer's default.",
  Disputed: "Inspection failed or timed out. An arbiter will settle the deposits.",
};

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const orderId = id as Hex;
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const publicClient = usePublicClient();
  const tx = useTx();
  const [tracking, setTracking] = useState("");

  const { data: o, refetch, isLoading } = useReadContract({
    address: deployment?.escrow,
    abi: vaultEscrowAbi,
    functionName: "getOrder",
    args: [orderId],
    query: { enabled: !!deployment && /^0x[0-9a-fA-F]{64}$/.test(id) },
  });
  const { data: due } = useReadContract({
    address: deployment?.escrow,
    abi: vaultEscrowAbi,
    functionName: "expectedPayment",
    args: [orderId, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!deployment && !!address },
  });

  if (!deployment) return <div className="container-page pt-10"><Empty title="Connect to a network where VaultChain is deployed" /></div>;
  if (isLoading) return <div className="container-page"><Spinner /></div>;
  if (!o || o.status === 0) return <div className="container-page pt-10"><Empty title="Order not found on this network" /></div>;

  const status = ORDER_STATUS[o.status]!;
  const isBuyer = address?.toLowerCase() === o.buyer.toLowerCase();
  const isSeller = address?.toLowerCase() === o.seller.toLowerCase();
  const deadline = o.deadline > 0n ? new Date(Number(o.deadline) * 1000).toISOString() : undefined;
  const expired = deadline ? new Date(deadline).getTime() < Date.now() : false;
  const call = (functionName: string, args: unknown[], label: string) =>
    tx.run((w) => w({ address: deployment.escrow, abi: vaultEscrowAbi as Abi, functionName, args, label })).then(() => refetch());

  async function payWithWallet() {
    if (!address || !due) return;
    await tx.run(async (w) => {
      await ensureAllowance(w, publicClient!, deployment!.usdc, address, deployment!.escrow, due);
      return w({ address: deployment!.escrow, abi: vaultEscrowAbi as Abi, functionName: "fund", args: [orderId], label: "Paying" });
    });
    refetch();
  }

  const claim: Record<string, [string, string]> = {
    Signed: ["cancelUnfunded", "Cancel and refund deposits"],
    Locked: ["claimSellerNoShow", "Claim: seller did not ship"],
    Inspecting: ["escalateInspectionTimeout", "Escalate: inspection timed out"],
    PaymentWindow: ["claimBuyerDefault", "Claim: buyer did not pay"],
  };

  return (
    <div className="container-page">
      <PageHeader title={`Order ${short(orderId, 6)}`} back={{ href: "/orders", label: "Orders" }} />
      <div className="mt-6">
        <Timeline steps={STEPS} current={STEP_OF[status] ?? 0} failed={FAILED[status]} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Terms</div>
            <Badge tone="gold">{status}</Badge>
          </div>
          <div className="mt-3">
            <KV k="Price" v={usd(fromUsd6(o.priceUsd), true)} />
            <KV k="Deposit (each side)" v={usd(fromUsd6(o.depositUsd), true)} />
            <KV k="Fair value at signing" v={usd(fromUsd6(o.refFairValueUsd), true)} />
            <KV k="Buyer" v={<span className="font-mono">{short(o.buyer)}{isBuyer && " (you)"}</span>} />
            <KV k="Seller" v={<span className="font-mono">{short(o.seller)}{isSeller && " (you)"}</span>} />
            <KV k="After inspection" v={o.fulfillment === 1 ? "Keep in vault (NFT)" : "Ship to buyer"} />
            <KV k="Deposits" v={`buyer ${o.buyerDeposited ? "✓" : "—"} · seller ${o.sellerDeposited ? "✓" : "—"}`} />
            <KV k="Current deadline" v={deadline ? `${new Date(deadline).toLocaleString()} (${timeLeft(deadline)})` : "—"} />
          </div>
        </div>

        <div className="panel p-5">
          <div className="font-semibold">Your next step</div>
          <div className="mt-3 grid gap-3">
            {due !== undefined && due > 0n && (
              <>
                <p className="text-sm text-neutral-300">
                  {status === "Signed" ? "Lock your deposit" : "Pay the full price"}: <b className="text-white">{usd(fromUsd6(due), true)}</b>
                </p>
                <button className="btn-gold" onClick={payWithWallet} disabled={tx.state.status === "pending"}>
                  Pay from wallet (USDC)
                </button>
                <HspPay target="order" id={orderId} />
              </>
            )}
            {status === "Locked" && isSeller && !expired && (
              <div className="grid gap-2">
                <p className="text-sm text-neutral-300">Ship the slab to the vault and enter the tracking number. Only a hash of it goes on-chain.</p>
                <input className="input" placeholder="Courier + tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                <button className="btn-gold" disabled={!tracking} onClick={() => call("markShipped", [orderId, keccak256(toBytes(tracking.trim()))], "Marking shipped")}>
                  Mark as shipped
                </button>
              </div>
            )}
            {status === "Inspecting" && <p className="text-sm text-neutral-300">The vault is inspecting the card. You&apos;ll be able to pay once it passes.</p>}
            {status === "AwaitingDelivery" && <p className="text-sm text-neutral-300">Paid. The vault is shipping the card to the buyer.</p>}
            {status === "Completed" && <p className="text-sm text-up">Done. {o.fulfillment === 1 ? "The NFT is in the buyer's wallet." : "Delivered."}</p>}
            {expired && claim[status] && (
              <button className="btn-danger" onClick={() => call(claim[status]![0], [orderId], claim[status]![1])}>
                {claim[status]![1]}
              </button>
            )}
            {status === "BuyerDefault" && isSeller && !o.sellerBuyoutConsent && (
              <button className="btn-ghost" onClick={() => call("consentToBuyout", [orderId], "Consenting to buyout")}>
                Let VaultChain buy the card at the agreed price
              </button>
            )}
            <TxStatus state={tx.state} />
          </div>
        </div>
      </div>
      <Credits />
    </div>
  );
}
