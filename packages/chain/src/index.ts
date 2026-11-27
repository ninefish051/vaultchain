import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainById, requireDeployment, type Deployment } from "@vaultchain/shared";

/**
 * Server-side chain access for services. Env:
 *   CHAIN_ID         133 (HSK testnet) | 177 (HSK mainnet) | 11155111 (Sepolia) | 31337 (anvil)
 *   RPC_URL          overrides the chain's default RPC
 *   DEPLOYMENT_JSON  optional inline JSON overriding packages/shared/src/deployments.json
 */
export function chainContext() {
  const chainId = Number(process.env.CHAIN_ID ?? 133);
  const chain = chainById(chainId);
  if (!chain) throw new Error(`Unsupported CHAIN_ID ${chainId}`);
  const transport = http(process.env.RPC_URL ?? chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const deployment: Deployment = process.env.DEPLOYMENT_JSON
    ? (JSON.parse(process.env.DEPLOYMENT_JSON) as Deployment)
    : requireDeployment(chainId);
  return { chainId, chain, transport, publicClient, deployment };
}

/** Wallet for a private key held in an env var (loaded from AWS Secrets Manager in production). */
export function walletFromKey(envName: string) {
  const key = process.env[envName] as Hex | undefined;
  if (!key) throw new Error(`${envName} is not set`);
  const { chain, transport } = chainContext();
  const account = privateKeyToAccount(key);
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

export const lower = (a: Address | string) => a.toLowerCase() as Address;

/** Reads logs in block ranges small enough for public RPCs. */
export async function* blockRanges(from: bigint, to: bigint, step = 5_000n) {
  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n > to ? to : start + step - 1n;
    yield { fromBlock: start, toBlock: end };
  }
}
