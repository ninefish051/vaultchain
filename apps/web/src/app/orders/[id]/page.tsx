"use client";

import { use, useState } from "react";
import { keccak256, toBytes, type Abi, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { ORDER_STATUS, fromUsd6, vaultEscrowAbi } from "@vaultchain/shared";
import { ensureAllowance, useDeployment, useTx } from "@/lib/contracts";
import { short, timeLeft, usd } from "@/lib/format";
import { HspPay } from "@/components/HspPay";
import { ShippingForm, VaultAddress } from "@/components/ShippingForm";
import { Timeline } from "@/components/Timeline";
import { Credits } from "@/components/Credits";
import { Badge, Empty, KV, PageHeader, Spinner, TxStatus } from "@/components/ui";
import { InfoTip } from "@/components/shop";
import Link from "next/link";
import { CircleCheck, Clock, CornerDownRight, Hourglass, PartyPopper, ScanSearch, Truck } from "lucide-react";

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
  const [hspActive, setHspActive] = useState(false);

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
            <KV
              k="Deposits"
              v={
                <span className="inline-flex items-center gap-3">
                  {[["Buyer", o.buyerDeposited], ["Seller", o.sellerDeposited]].map(([who, paid]) => (
                    <span key={who as string} className={`inline-flex items-center gap-1 ${paid ? "text-up" : "text-neutral-500"}`}>
                      {paid ? <CircleCheck className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />} {who as string}
                    </span>
                  ))}
                </span>
              }
            />
            <KV k="Current deadline" v={deadline ? `${new Date(deadline).toLocaleString()} (${timeLeft(deadline)})` : "—"} />
          </div>
        </div>

        <div className="panel p-5">
          <div className="flex items-center gap-2 font-semibold">
            <CornerDownRight className="h-4 w-4 text-gold" /> Your next step
          </div>
          <div className="mt-3 grid gap-3">
            {due !== undefined && due > 0n && (
              <>
                <p className="text-sm text-neutral-300">
                  {status === "Signed" ? "Lock your deposit" : "Pay the full price"}: <b className="text-white">{usd(fromUsd6(due), true)}</b>
                </p>
                {!hspActive && (
                  <button className="btn-gold" onClick={payWithWallet} disabled={tx.state.status === "pending"}>
                    Pay from wallet (USDC)
                  </button>
                )}
                <HspPay target="order" id={orderId} onActiveChange={setHspActive} />
              </>
            )}
            {status === "Locked" && isSeller && !expired && (
              <div className="grid gap-2">
                <VaultAddress />
                <p className="flex items-center gap-1.5 text-sm text-neutral-300">
                  <Truck className="h-4 w-4 text-gold" /> Ship it, then add the tracking number
                  <InfoTip>Only a hash of the tracking number is stored on-chain.</InfoTip>
                </p>
                <input className="input" placeholder="Courier + tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                <button className="btn-gold" disabled={!tracking} onClick={() => call("markShipped", [orderId, keccak256(toBytes(tracking.trim()))], "Marking shipped")}>
                  Mark as shipped
                </button>
              </div>
            )}
            {status === "Inspecting" && (
              <p className="flex items-center gap-2 text-sm text-neutral-300">
                <ScanSearch className="h-4 w-4 text-gold" /> The vault is checking the card.
              </p>
            )}
            {status === "AwaitingDelivery" && (
              <p className="flex items-center gap-2 text-sm text-neutral-300">
                <Truck className="h-4 w-4 text-gold" /> Paid. The card is on its way to the buyer.
              </p>
            )}
            {status === "Signed" && due === 0n && (
              <p className="flex items-center gap-2 text-sm text-neutral-300">
                <Hourglass className="h-4 w-4 text-gold" /> Waiting for the other side&apos;s deposit.
              </p>
            )}
            {status === "Completed" && (
              <div className="flex items-center gap-3 rounded-xl border border-up/30 bg-up/10 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-up/20 text-up">
                  <PartyPopper className="h-5 w-5" />
                </span>
                <div className="text-sm">
                  <div className="font-semibold text-white">Deal done</div>
                  <div className="text-neutral-300">
                    {o.fulfillment === 1 ? (
                      <>The card is in the buyer&apos;s vault. {isBuyer && <Link href="/assets" className="text-gold underline">See my cards</Link>}</>
                    ) : (
                      "Delivered."
                    )}
                  </div>
                </div>
              </div>
            )}
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
            {isBuyer && o.fulfillment === 0 && !["Cancelled", "SellerDefault", "Refunded", "Completed"].includes(status) && (
              <ShippingForm target="order" targetId={orderId} />
            )}
            <TxStatus state={tx.state} />
          </div>
        </div>
      </div>
      <Credits />
    </div>
  );
}
