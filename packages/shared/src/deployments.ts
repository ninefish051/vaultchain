import type { Address } from "viem";
import deployments from "./deployments.json";

export interface Deployment {
  chainId: number;
  usdc: Address;
  oracle: Address;
  nft: Address;
  escrow: Address;
  market: Address;
  swapEscrow: Address;
  vaultSwap: Address;
  deployedAtBlock: number;
}

/** Addresses written by contracts/script/Deploy.s.sol, synced with `pnpm --filter @vaultchain/shared sync:deployments`. */
export function getDeployment(chainId: number): Deployment | undefined {
  return (deployments as Record<string, Deployment>)[String(chainId)];
}

export function requireDeployment(chainId: number): Deployment {
  const d = getDeployment(chainId);
  if (!d) throw new Error(`VaultChain contracts are not deployed on chain ${chainId}`);
  return d;
}
