"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useAccount, useSignMessage, useSignTypedData } from "wagmi";
import { Loader2, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/contracts";
import { short } from "@/lib/format";

type Step =
  | { s: "idle" }
  | { s: "preparing" }
  | { s: "confirm"; data: Awaited<ReturnType<typeof api.hspCheckout>>; at: number }
  | { s: "submitting" }
  | { s: "waiting"; id: string; status: string }
  | { s: "done"; tx?: string }
  | { s: "error"; msg: string };

/**
 * Pays what is due on an order/swap through HSP (HashKey Settlement Platform). The server creates
 * the HSP cart with pay_to = the escrow contract; the user reviews recipient, payer and amount and
 * signs the EIP-3009 authorization in their wallet; the keeper records it on-chain once finalized.
 */
/** HSP quotes are valid for 5 minutes; re-prepare a little before that. */
const QUOTE_TTL_MS = 4.5 * 60_000;

export function HspPay({ target, id, onActiveChange }: { target: "order" | "swap"; id: Hex; onActiveChange?: (active: boolean) => void }) {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const [step, setStep] = useState<Step>({ s: "idle" });

  // While an HSP payment is in flight the page hides "pay from wallet", so the same amount is never paid twice.
  const active = step.s !== "idle" && step.s !== "error";
  useEffect(() => onActiveChange?.(active), [active, onActiveChange]);

  async function start() {
    if (!address) return;
    setStep({ s: "preparing" });
    try {
      setStep({ s: "confirm", data: await api.hspCheckout({ target, id, payer: address }, signMessageAsync), at: Date.now() });
    } catch (e) {
      setStep({ s: "error", msg: errorMessage(e) });
    }
  }

  async function signAndSubmit() {
    if (step.s !== "confirm" || !address) return;
    let data = step.data;
    try {
      if (Date.now() - step.at > QUOTE_TTL_MS) {
        // quote expired while the user was reviewing: prepare a fresh payment with the same amount due
        setStep({ s: "preparing" });
        data = await api.hspCheckout({ target, id, payer: address }, signMessageAsync);
        setStep({ s: "confirm", data, at: Date.now() });
      }
      const { prepared, paymentRequestId } = data;
      const signature = await signTypedDataAsync(prepared.eip712 as Parameters<typeof signTypedDataAsync>[0]);
      setStep({ s: "submitting" });
      await api.hspSubmit({
        paymentRequestId,
        signature,
        payment_payload: prepared.payment_payload,
        payment_mandate_contents: prepared.payment_mandate_contents,
        cart_hash: prepared.cart_hash,
      });
      setStep({ s: "waiting", id: paymentRequestId, status: "submitted" });
      poll(paymentRequestId);
    } catch (e) {
      setStep({ s: "error", msg: errorMessage(e) });
    }
  }

  function poll(pid: string) {
    const t = setInterval(async () => {
      try {
        const st = await api.hspStatus(pid);
        if (st.status === "recorded") {
          clearInterval(t);
          setStep({ s: "done", tx: st.recordTx });
        } else if (st.status === "failed") {
          clearInterval(t);
          setStep({ s: "error", msg: st.lastError ?? "Payment failed" });
        } else setStep({ s: "waiting", id: pid, status: st.status });
      } catch {
        /* keep polling */
      }
    }, 15_000);
  }

  if (step.s === "idle")
    return (
      <button className="btn-ghost w-full" onClick={start} disabled={!address}>
        <Zap className="h-4 w-4" /> Pay with HSP
      </button>
    );
  if (step.s === "preparing" || step.s === "submitting")
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-300">
        <Loader2 className="h-4 w-4 animate-spin" /> {step.s === "preparing" ? "Creating HSP payment…" : "Submitting to HSP…"}
      </div>
    );
  if (step.s === "confirm")
    return (
      <div className="rounded-xl border border-gold/40 bg-gold/5 p-4 text-sm">
        <div className="font-semibold text-gold">Confirm HSP payment</div>
        <div className="mt-2 grid gap-1">
          <div>Recipient (escrow contract): <span className="font-mono">{short(step.data.payTo, 6)}</span></div>
          <div>Payer: <span className="font-mono">{short(address, 6)}</span></div>
          <div>Amount: <b>${step.data.amountUsd}</b> USDC {step.data.prepared.token_total_raw && <span className="text-neutral-400">({step.data.prepared.token_total_raw} raw)</span>}</div>
        </div>
        <div className="mt-3 flex gap-2">
          <button className="btn-gold" onClick={signAndSubmit}>Sign &amp; pay</button>
          <button className="btn-ghost" onClick={() => setStep({ s: "idle" })}>Cancel</button>
        </div>
      </div>
    );
  if (step.s === "waiting")
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-300">
        <Loader2 className="h-4 w-4 animate-spin" /> HSP status: {step.status}. Waiting for final confirmation (checked every 15s)…
      </div>
    );
  if (step.s === "done") return <div className="text-sm text-up">Paid via HSP and recorded on-chain.</div>;
  return (
    <div className="text-sm text-down">
      {step.msg}{" "}
      <button className="underline" onClick={() => setStep({ s: "idle" })}>
        Try again
      </button>
    </div>
  );
}
