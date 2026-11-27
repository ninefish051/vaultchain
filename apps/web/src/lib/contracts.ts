"use client";

import { useCallback, useState } from "react";
import { BaseError, erc20Abi, maxUint256, type Abi, type Address, type Hex } from "viem";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import { getDeployment } from "@vaultchain/shared";

export function useDeployment() {
  const chainId = useChainId();
  return { chainId, deployment: getDeployment(chainId) };
}

export function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => (x as { data?: { errorName?: string } }).data?.errorName !== undefined) as
      | { data?: { errorName?: string } }
      | null;
    return reverted?.data?.errorName ?? e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export type WriteCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; label?: string };
export type WriteFn = (call: WriteCall) => Promise<Hex>;

export type TxState = { status: "idle" | "pending" | "success" | "error"; hash?: Hex; error?: string; label?: string };

/**
 * Runs one or more contract writes in sequence, waiting for each receipt.
 * Simulates first so reverts surface with the contract's error name before the wallet opens.
 */
export function useTx() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const write: WriteFn = useCallback(
    async (call: WriteCall) => {
      if (!publicClient || !address) throw new Error("Connect a wallet first");
      setState({ status: "pending", label: call.label });
      await publicClient.simulateContract({ ...call, account: address } as Parameters<typeof publicClient.simulateContract>[0]);
      const hash = await writeContractAsync(call as Parameters<typeof writeContractAsync>[0]);
      setState({ status: "pending", hash, label: call.label });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      return hash;
    },
    [address, publicClient, writeContractAsync],
  );

  const run = useCallback(
    async (fn: (w: WriteFn) => Promise<Hex | void>) => {
      try {
        const hash = await fn(write);
        setState({ status: "success", hash: hash ?? undefined });
        return hash;
      } catch (e) {
        setState({ status: "error", error: errorMessage(e) });
        return undefined;
      }
    },
    [write],
  );

  return { state, run, reset: () => setState({ status: "idle" }) };
}

/** Approves `spender` for USDC if the current allowance is below `amount`. */
export async function ensureAllowance(
  write: WriteFn,
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return;
  await write({ address: token, abi: erc20Abi as Abi, functionName: "approve", args: [spender, maxUint256], label: "Approve USDC" });
}
