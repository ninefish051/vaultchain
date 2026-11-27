import type { Address, Hex } from "viem";
import type {
  CardType,
  Listing,
  Offer,
  OrderDto,
  PricePointSeries,
  PriceSnapshot,
  SaleRecord,
  SwapDto,
  SwapOfferDto,
  VaultAsset,
} from "@vaultchain/shared";

export interface CardSummary extends CardType {
  price?: PriceSnapshot;
  listingCount: number;
  lowestAskUsd?: number;
}

export interface CardQuery {
  q?: string;
  grader?: string;
  grade?: string;
  minUsd?: number;
  maxUsd?: number;
  sort?: "price_desc" | "price_asc" | "change_desc" | "change_asc" | "name";
}

export type ShippingTarget = "order" | "swap" | "redeem";

export interface ListingQuery {
  type?: "vault" | "escrow";
  acceptsSwap?: boolean;
  cardKey?: Hex;
  seller?: Address;
}

export interface ListingView extends Listing {
  card: CardType;
  price?: PriceSnapshot;
}

export interface Proposal {
  id: string;
  kind: "order" | "swap";
  proposer: Address;
  counterparty: Address;
  terms: Record<string, unknown>; // OrderTerms | SwapTerms with bigints as strings
  proposerSig: Hex;
  status: "open" | "accepted" | "cancelled";
  createdAt: string;
}

export interface NewListing {
  type: "vault" | "escrow";
  slabId: Hex;
  tokenId?: string;
  cardKey: Hex;
  certNumber: string;
  seller: Address;
  priceUsd: number;
  acceptsSwap: boolean;
  swapWants?: string;
  images: string[];
  floorUsd?: number;
  verified: boolean;
}

/** Persistence boundary: Postgres in production, in-memory demo data otherwise. */
export interface Store {
  readonly mode: "postgres" | "demo";
  listCards(q: CardQuery): Promise<CardSummary[]>;
  getCard(cardKey: Hex): Promise<CardType | undefined>;
  priceSnapshot(cardKey: Hex): Promise<PriceSnapshot | undefined>;
  priceHistory(cardKey: Hex, days: number): Promise<PricePointSeries[]>;
  sales(cardKey: Hex, limit: number): Promise<SaleRecord[]>;

  listListings(q: ListingQuery): Promise<ListingView[]>;
  getListing(id: string): Promise<ListingView | undefined>;
  createListing(l: NewListing): Promise<Listing>;
  cancelListing(id: string): Promise<void>;

  /** Active or reserved listing of this physical slab, if any. */
  findOpenListingBySlab(slabId: Hex): Promise<(ListingView & { status: "active" | "reserved" }) | undefined>;
  /** Seller's private auto-accept floor (never returned by public endpoints). */
  listingFloor(id: string): Promise<number | undefined>;

  listOffers(listingId: string): Promise<Offer[]>;
  listOffersFor(q: { buyer?: Address; seller?: Address }): Promise<(Offer & { listing?: ListingView })[]>;
  createOffer(o: { listingId: string; buyer: Address; priceUsd: number; viaAgent: boolean }): Promise<Offer>;
  updateOffer(id: string, patch: Partial<Pick<Offer, "status" | "counterUsd">>): Promise<Offer | undefined>;

  listProposals(address: Address): Promise<Proposal[]>;
  createProposal(p: Omit<Proposal, "id" | "status" | "createdAt">): Promise<Proposal>;
  updateProposal(id: string, status: Proposal["status"]): Promise<Proposal | undefined>;
  getProposal(id: string): Promise<Proposal | undefined>;

  listVaultSwapOffers(): Promise<SwapOfferDto[]>;
  listOrders(address?: Address): Promise<OrderDto[]>;
  getOrder(id: Hex): Promise<OrderDto | undefined>;
  listSwaps(address?: Address): Promise<SwapDto[]>;
  getSwap(id: Hex): Promise<SwapDto | undefined>;
  listAssets(owner: Address): Promise<VaultAsset[]>;

  slabInfo(slabId: Hex): Promise<{ cardKey: Hex; grader: string; certNumber: string } | undefined>;
  saveShipping(s: { target: ShippingTarget; targetId: string; wallet: Address; ciphertext: string }): Promise<void>;
  shipping(target: ShippingTarget, targetId: string): Promise<{ wallet: Address; ciphertext: string; createdAt: string }[]>;

  registerSlab(s: { slabId: Hex; cardKey: Hex; grader: string; certNumber: string; metadata: unknown; metadataHash: Hex }): Promise<void>;
  recordHspPayment(p: { paymentRequestId: string; flowId: string; target: "order" | "swap"; targetId: Hex; payer: Address; amountUsd6: bigint }): Promise<void>;
  hspPayment(paymentRequestId: string): Promise<{ status: string; recordTx?: string; lastError?: string } | undefined>;
  setHspStatus(paymentRequestId: string, status: string): Promise<void>;
}
