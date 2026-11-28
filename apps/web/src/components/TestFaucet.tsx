"use client";

// TESTNET ONLY — REMOVE BEFORE MAINNET LAUNCH.
// Lets a connected wallet mint MockUSDC on HSK testnet so people can try deposits and payments.
// Shown only when the build sets NEXT_PUBLIC_ENABLE_TEST_FAUCET=true and the wallet is not on mainnet.
// To remove: delete this file, its <TestFaucet /> line in Header.tsx, and the build variable.

import type { Abi } from "viem";
import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { fromUsd6, hskMainnet, mockUSDCAbi, toUsd6 } from "@vaultchain/shared";
import { useDeployment, useTx } from "@/lib/contracts";
import { usd } from "@/lib/format";
import { TxStatus } from "./ui";

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_TEST_FAUCET === "true";
const MINT_USD = 10_000;
const GAS_FAUCET_URL = "https://faucet.hskchain.net/faucet";

export function TestFaucet() {
  const { address } = useAccount();
  const { deployment, chainId } = useDeployment();
  const tx = useTx();
  const active = ENABLED && !!address && !!deployment && chainId !== hskMainnet.id;
  const { data: balance, refetch } = useReadContract({
    address: deployment?.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: active },
  });
  if (!active) return null;

  async function mint() {
    await tx.run((write) =>
      write({
        address: deployment!.usdc,
        abi: mockUSDCAbi as Abi,
        functionName: "mint",
        args: [address!, toUsd6(MINT_USD)],
        label: `Minting ${MINT_USD.toLocaleString()} test USDC`,
      }),
    );
    refetch();
  }

  return (
    <div className="border-t border-sky-500/30 bg-sky-500/10 py-2 text-xs text-sky-200">
      <div className="container-page flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-semibold uppercase tracking-wide">Testnet</span>
        <span>
          Test USDC balance: <b className="text-white">{usd(fromUsd6(balance ?? 0n), true)}</b>
        </span>
        <button
          className="rounded-md bg-sky-500 px-3 py-1 font-semibold text-ink-900 transition hover:bg-sky-400 disabled:opacity-50"
          onClick={mint}
          disabled={tx.state.status === "pending"}
        >
          Get {MINT_USD.toLocaleString()} test USDC
        </button>
        <span className="text-sky-200/80">
          Need HSK for gas?{" "}
          <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="underline hover:text-white">
            HSK testnet faucet
          </a>
        </span>
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}
