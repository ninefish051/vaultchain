import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia } from "viem/chains";
import { anvil, hskMainnet, hskTestnet } from "@vaultchain/shared";

const chains =
  process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === "true"
    ? ([hskTestnet, hskMainnet, sepolia, anvil] as const)
    : ([hskTestnet, hskMainnet, sepolia] as const);

export const wagmiConfig = getDefaultConfig({
  appName: "VaultChain",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "vaultchain-dev",
  chains,
  ssr: true,
});

export const DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? hskTestnet.id);
