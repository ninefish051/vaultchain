"use client";

import type { Abi } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { fromUsd6, swapEscrowAbi, vaultEscrowAbi } from "@vaultchain/shared";
import { useDeployment, useTx } from "@/lib/contracts";
import { usd } from "@/lib/format";
import { TxStatus } from "./ui";

/** Balances owed to the user by both escrows (pull payments). */
export function Credits() {
  const { address } = useAccount();
  const { deployment } = useDeployment();
  const tx = useTx();
  const { data, refetch } = useReadContracts({
    contracts: deployment && address
      ? [
          { address: deployment.escrow, abi: vaultEscrowAbi, functionName: "credits", args: [address] },
          { address: deployment.swapEscrow, abi: swapEscrowAbi, functionName: "credits", args: [address] },
        ]
      : [],
    query: { enabled: !!deployment && !!address },
  });
  const order = (data?.[0]?.result as bigint | undefined) ?? 0n;
  const swap = (data?.[1]?.result as bigint | undefined) ?? 0n;
  if (!deployment || (order === 0n && swap === 0n)) return null;

  async function withdraw() {
    await tx.run(async (write) => {
      let h;
      if (order > 0n) h = await write({ address: deployment!.escrow, abi: vaultEscrowAbi as Abi, functionName: "withdraw", label: "Withdrawing order balance" });
      if (swap > 0n) h = await write({ address: deployment!.swapEscrow, abi: swapEscrowAbi as Abi, functionName: "withdraw", label: "Withdrawing swap balance" });
      return h;
    });
    refetch();
  }

  return (
    <div className="panel mt-6 flex flex-wrap items-center justify-between gap-4 border-gold/40 p-4">
      <div>
        <div className="label">Available to withdraw</div>
        <div className="text-2xl font-bold text-gold">{usd(fromUsd6(order + swap), true)}</div>
        <div className="text-xs text-neutral-400">Returned deposits, sale proceeds, top-ups and compensation.</div>
      </div>
      <div>
        <button className="btn-gold" onClick={withdraw} disabled={tx.state.status === "pending"}>
          Withdraw USDC
        </button>
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}
