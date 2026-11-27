import type { Address, Hex } from "viem";
import type { Grader } from "./cardKey";
import type { Custody, OrderStatus, SwapStatus } from "./status";
import type { SaleKind } from "./pricing";

/** API DTOs shared by services/api and apps/web. Money is USD as a number (2 decimals). */

export interface CardType {
  cardKey: Hex;
  canonical: string;
  name: string; // "Charizard"
  setName: string; // "Base Set"
  number: string;
  language: string;
  variant: string;
  grader: Grader;
  grade: string;
  imageUrl: string;
  year?: number;
}

export interface PriceSnapshot {
  cardKey: Hex;
  fairValueUsd: number;
  volatilityBps: number;
  confidence: number;
  sampleCount: number;
  change24hPct: number;
  change30dPct: number;
  updatedAt: string;
  onChain?: { fairValueUsd: number; updatedAt: string; txHash?: Hex };
}

export interface PricePointSeries {
  date: string; // YYYY-MM-DD
  fairValueUsd: number;
}

export interface SaleRecord {
  source: string;
  kind: SaleKind;
  priceUsd: number;
  originalPrice?: number;
  currency?: string;
  observedAt: string;
  title?: string;
  url?: string;
}

/** A listing in the marketplace: either a vault NFT or a card still with the seller (escrow trade). */
export interface Listing {
  id: string;
  type: "vault" | "escrow";
  slabId: Hex;
  tokenId?: string;
  cardKey: Hex;
  certNumber: string;
  seller: Address;
  priceUsd: number;
  acceptsSwap: boolean;
  swapWants?: string; // free text / cardKey description
  images: string[];
  createdAt: string;
  /** Escrow listings: PSA cert checked against the card type. Vault listings are always verified. */
  verified?: boolean;
}

export interface Offer {
  id: string;
  listingId: string;
  buyer: Address;
  priceUsd: number;
  status: "open" | "accepted" | "rejected" | "countered" | "expired";
  counterUsd?: number;
  createdAt: string;
}

export interface SwapOfferDto {
  id: string; // on-chain offerId for vault swaps, uuid for escrow swap proposals
  type: "vault" | "escrow";
  maker: Address;
  giveSlabId: Hex;
  giveCardKey: Hex;
  wantSlabId?: Hex;
  wantCardKey?: Hex;
  topUpUsd: number;
  makerPaysTopUp: boolean;
  expiresAt: string;
  status: "open" | "accepted" | "cancelled" | "expired";
}

export interface OrderDto {
  orderId: Hex;
  buyer: Address;
  seller: Address;
  cardKey: Hex;
  slabId: Hex;
  priceUsd: number;
  depositUsd: number;
  status: OrderStatus;
  deadline?: string;
  fulfillment: "ShipToBuyer" | "KeepInVault";
  events: { status: string; at: string; txHash?: Hex }[];
}

export interface SwapDto {
  swapId: Hex;
  partyA: Address;
  partyB: Address;
  slabA: Hex;
  slabB: Hex;
  cardKeyA: Hex;
  cardKeyB: Hex;
  depositUsd: number;
  topUpUsd: number;
  topUpFrom: 0 | 1 | 2;
  status: SwapStatus;
  legState: ["Pending" | "Shipped" | "Passed", "Pending" | "Shipped" | "Passed"];
  deadline?: string;
  events: { status: string; at: string; txHash?: Hex }[];
}

export interface VaultAsset {
  tokenId: string;
  slabId: Hex;
  cardKey: Hex;
  owner: Address;
  custody: Custody;
  certNumber: string;
  grader: Grader;
}
