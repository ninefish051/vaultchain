import type { Address, Hex } from "viem";

/** EIP-712 domains and types. Must match the Solidity contracts exactly. */

export const oracleDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "VaultChain CardPriceOracle", version: "1", chainId, verifyingContract }) as const;

export const escrowDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "VaultChain Escrow", version: "1", chainId, verifyingContract }) as const;

export const swapEscrowDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "VaultChain SwapEscrow", version: "1", chainId, verifyingContract }) as const;

export const pricePointTypes = {
  PricePoint: [
    { name: "cardKey", type: "bytes32" },
    { name: "fairValueUsd", type: "uint128" },
    { name: "volatilityBps", type: "uint32" },
    { name: "sampleCount", type: "uint16" },
    { name: "confidence", type: "uint8" },
    { name: "updatedAt", type: "uint64" },
    { name: "evidenceHash", type: "bytes32" },
  ],
} as const;

export const orderTermsTypes = {
  OrderTerms: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "cardKey", type: "bytes32" },
    { name: "slabId", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
    { name: "priceUsd", type: "uint128" },
    { name: "depositWindow", type: "uint32" },
    { name: "shipWindow", type: "uint32" },
    { name: "inspectWindow", type: "uint32" },
    { name: "payWindow", type: "uint32" },
    { name: "fulfillment", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "signDeadline", type: "uint64" },
  ],
} as const;

export const swapTermsTypes = {
  SwapTerms: [
    { name: "a", type: "Leg" },
    { name: "b", type: "Leg" },
    { name: "topUpUsd", type: "uint128" },
    { name: "topUpFrom", type: "uint8" },
    { name: "depositWindow", type: "uint32" },
    { name: "shipWindow", type: "uint32" },
    { name: "inspectWindow", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "signDeadline", type: "uint64" },
  ],
  Leg: [
    { name: "owner", type: "address" },
    { name: "cardKey", type: "bytes32" },
    { name: "slabId", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "delivery", type: "uint8" },
  ],
} as const;

export interface PricePointMessage {
  cardKey: Hex;
  fairValueUsd: bigint;
  volatilityBps: number;
  sampleCount: number;
  confidence: number;
  updatedAt: bigint;
  evidenceHash: Hex;
}

export interface OrderTermsMessage {
  buyer: Address;
  seller: Address;
  cardKey: Hex;
  slabId: Hex;
  metadataHash: Hex;
  priceUsd: bigint;
  depositWindow: number;
  shipWindow: number;
  inspectWindow: number;
  payWindow: number;
  fulfillment: number; // 0 ship to buyer, 1 keep in vault
  nonce: bigint;
  signDeadline: bigint;
}

export interface LegMessage {
  owner: Address;
  cardKey: Hex;
  slabId: Hex;
  metadataHash: Hex;
  kind: number; // 0 physical, 1 vaulted
  delivery: number; // 0 ship to counterparty, 1 keep in vault
}

export interface SwapTermsMessage {
  a: LegMessage;
  b: LegMessage;
  topUpUsd: bigint;
  topUpFrom: number;
  depositWindow: number;
  shipWindow: number;
  inspectWindow: number;
  nonce: bigint;
  signDeadline: bigint;
}

export const DEFAULT_WINDOWS = {
  depositWindow: 24 * 3600,
  shipWindow: 3 * 24 * 3600,
  inspectWindow: 2 * 24 * 3600,
  payWindow: 2 * 24 * 3600,
} as const;
