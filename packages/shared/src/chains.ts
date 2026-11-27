import { defineChain } from "viem";
import { sepolia } from "viem/chains";

export const hskMainnet = defineChain({
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "HashKey Explorer", url: "https://hashkey.blockscout.com" } },
});

export const hskTestnet = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "HashKey Testnet Explorer", url: "https://testnet-explorer.hsk.xyz" } },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const supportedChains = [hskTestnet, hskMainnet, sepolia, anvil] as const;

export function chainById(id: number) {
  return supportedChains.find((c) => c.id === id);
}
