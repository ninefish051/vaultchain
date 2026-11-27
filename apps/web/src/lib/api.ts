"use client";

import { keccak256, toBytes, type Address, type Hex } from "viem";
import {
  DEMO_CARDS,
  DEMO_LISTINGS,
  demoPriceHistory,
  demoSales,
  demoSnapshot,
  orderDepositUsd,
  depositBpsFor,
  suggestTopUp,
  swapDepositUsd,
  type CardType,
  type Listing,
  type Offer,
  type OrderDto,
  type PricePointSeries,
  type PriceSnapshot,
  type SaleRecord,
  type SwapDto,
  type SwapOfferDto,
  type VaultAsset,
} from "@vaultchain/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4100";

export type CardSummary = CardType & { price?: PriceSnapshot; listingCount: number; lowestAskUsd?: number };
export type ListingView = Listing & { card: CardType; price?: PriceSnapshot };
export type CardDetail = { card: CardType; price?: PriceSnapshot; history: PricePointSeries[]; sales: SaleRecord[]; listings: ListingView[] };
export interface Proposal {
  id: string;
  kind: "order" | "swap";
  proposer: Address;
  counterparty: Address;
  terms: Record<string, unknown>;
  proposerSig: Hex;
  status: "open" | "accepted" | "cancelled";
  createdAt: string;
}
export interface OrderQuote {
  fairValueUsd: number;
  volatilityBps: number;
  depositBps: number;
  depositUsd: number;
  deviationPct: number;
  warnings: string[];
}
export interface SwapQuote {
  fairValueA: number;
  fairValueB: number;
  topUpUsd: number;
  topUpFrom: 0 | 1 | 2;
  depositUsd: number;
  depositBps: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** True once a request failed to reach the API: the app then serves the built-in demo catalogue. */
export let usingDemoData = false;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(r.status, msg);
  }
  return (await r.json()) as T;
}

/** GET with a demo fallback when the API is unreachable (network error, not HTTP errors). */
async function read<T>(path: string, demo: () => T): Promise<T> {
  try {
    return await request<T>(path);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    usingDemoData = true;
    return demo();
  }
}

// ------------------------------------------------------------------ demo fallbacks

const cardByKey = new Map(DEMO_CARDS.map((c) => [c.cardKey, c]));
const demoListings = (): ListingView[] =>
  DEMO_LISTINGS.map((l) => ({ ...l, card: cardByKey.get(l.cardKey)!, price: demoSnapshot(l.cardKey) }));
const demoCards = (): CardSummary[] =>
  DEMO_CARDS.map((c) => {
    const ls = DEMO_LISTINGS.filter((l) => l.cardKey === c.cardKey);
    return { ...c, price: demoSnapshot(c.cardKey), listingCount: ls.length, lowestAskUsd: ls.length ? Math.min(...ls.map((l) => l.priceUsd)) : undefined };
  });

// ------------------------------------------------------------------ signed writes

export type SignMessage = (args: { message: string }) => Promise<Hex>;

export function signedRequestMessage(method: string, path: string, timestamp: string, body: string | undefined) {
  const bodyHash = body ? keccak256(toBytes(body)) : "0x0";
  return `VaultChain API\n${method.toUpperCase()} ${path}\n${timestamp}\n${bodyHash}`;
}

async function signed<T>(method: "POST" | "DELETE", path: string, body: unknown, address: Address, sign: SignMessage): Promise<T> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await sign({ message: signedRequestMessage(method, path, ts, raw) });
  return request<T>(path, { method, body: raw, headers: { "x-vc-address": address, "x-vc-timestamp": ts, "x-vc-signature": signature } });
}

// ------------------------------------------------------------------ endpoints

export const api = {
  cards: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return read<CardSummary[]>(`/cards?${qs}`, () => {
      const q = params.q?.toLowerCase();
      return demoCards()
        .filter((c) => !q || `${c.name} ${c.setName} ${c.grader} ${c.grade}`.toLowerCase().includes(q))
        .filter((c) => !params.grader || c.grader === params.grader)
        .sort((a, b) => (b.price?.fairValueUsd ?? 0) - (a.price?.fairValueUsd ?? 0));
    });
  },
  card: (cardKey: string) =>
    read<CardDetail>(`/cards/${cardKey}`, () => ({
      card: cardByKey.get(cardKey as Hex)!,
      price: demoSnapshot(cardKey as Hex),
      history: demoPriceHistory(cardKey as Hex),
      sales: demoSales(cardKey as Hex),
      listings: demoListings().filter((l) => l.cardKey === cardKey),
    })),
  listings: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return read<ListingView[]>(`/listings?${qs}`, () =>
      demoListings()
        .filter((l) => !params.type || l.type === params.type)
        .filter((l) => params.acceptsSwap !== "true" || l.acceptsSwap)
        .filter((l) => !params.seller || l.seller.toLowerCase() === params.seller.toLowerCase()),
    );
  },
  listing: (id: string) =>
    read<ListingView & { offers: Offer[] }>(`/listings/${encodeURIComponent(id)}`, () => ({ ...demoListings().find((l) => l.id === id)!, offers: [] })),
  quoteOrder: async (cardKey: Hex, priceUsd: number): Promise<OrderQuote> => {
    try {
      return await request<OrderQuote>("/quote/order", { method: "POST", body: JSON.stringify({ cardKey, priceUsd }) });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const s = demoSnapshot(cardKey)!;
      return {
        fairValueUsd: s.fairValueUsd,
        volatilityBps: s.volatilityBps,
        depositBps: depositBpsFor(s.volatilityBps),
        depositUsd: orderDepositUsd(priceUsd, s.volatilityBps),
        deviationPct: Math.round(((priceUsd - s.fairValueUsd) / s.fairValueUsd) * 10_000) / 100,
        warnings: [],
      };
    }
  },
  quoteSwap: async (cardKeyA: Hex, cardKeyB: Hex): Promise<SwapQuote> => {
    try {
      return await request<SwapQuote>("/quote/swap", { method: "POST", body: JSON.stringify({ cardKeyA, cardKeyB }) });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const a = demoSnapshot(cardKeyA)!;
      const b = demoSnapshot(cardKeyB)!;
      return {
        fairValueA: a.fairValueUsd,
        fairValueB: b.fairValueUsd,
        ...suggestTopUp(a.fairValueUsd, b.fairValueUsd),
        depositUsd: swapDepositUsd(a.fairValueUsd, b.fairValueUsd, a.volatilityBps, b.volatilityBps),
        depositBps: depositBpsFor(Math.max(a.volatilityBps, b.volatilityBps)),
      };
    }
  },
  swapOffers: () => read<SwapOfferDto[]>("/swap-offers", () => []),
  proposals: (address: Address) => read<Proposal[]>(`/proposals?address=${address}`, () => []),
  orders: (address: Address) => read<OrderDto[]>(`/orders?address=${address}`, () => []),
  order: (id: string) => request<OrderDto>(`/orders/${id}`),
  swaps: (address: Address) => read<SwapDto[]>(`/swaps?address=${address}`, () => []),
  swap: (id: string) => request<SwapDto>(`/swaps/${id}`),
  assets: (owner: Address) =>
    read<VaultAsset[]>(`/assets?owner=${owner}`, () =>
      DEMO_LISTINGS.filter((l) => l.type === "vault" && l.seller.toLowerCase() === owner.toLowerCase()).map((l) => ({
        tokenId: l.tokenId!,
        slabId: l.slabId,
        cardKey: l.cardKey,
        owner,
        custody: "InVault" as const,
        certNumber: l.certNumber,
        grader: cardByKey.get(l.cardKey)!.grader,
      })),
    ),
  psa: (cert: string) => request<Record<string, string | number | undefined>>(`/psa/${cert}`),
  vaultQueue: () => request<{ inspectOrders: OrderDto[]; inspectSwaps: SwapDto[]; deliveries: (OrderDto | SwapDto)[]; disputes: (OrderDto | SwapDto)[]; returns: OrderDto[] }>("/vault/queue"),
  hspStatus: (id: string) => request<{ status: string; recordTx?: string; lastError?: string }>(`/hsp/${id}`),

  // writes (wallet-signed)
  createListing: (body: unknown, a: Address, s: SignMessage) => signed<Listing>("POST", "/listings", body, a, s),
  cancelListing: (id: string, a: Address, s: SignMessage) => signed<{ ok: true }>("DELETE", `/listings/${encodeURIComponent(id)}`, undefined, a, s),
  createOffer: (body: { listingId: string; priceUsd: number; viaAgent?: boolean }, a: Address, s: SignMessage) => signed<Offer>("POST", "/offers", body, a, s),
  respondOffer: (id: string, body: { listingId: string; action: "accept" | "reject" | "counter"; counterUsd?: number }, a: Address, s: SignMessage) =>
    signed<Offer>("POST", `/offers/${id}/respond`, body, a, s),
  createProposal: (body: { kind: "order" | "swap"; counterparty: Address; terms: Record<string, unknown>; proposerSig: Hex }, a: Address, s: SignMessage) =>
    signed<Proposal>("POST", "/proposals", body, a, s),
  setProposalStatus: (id: string, status: "accepted" | "cancelled", a: Address, s: SignMessage) =>
    signed<Proposal>("POST", `/proposals/${id}/status`, { status }, a, s),
  registerSlab: (body: unknown, a: Address, s: SignMessage) => signed<{ slabId: Hex; tokenId: string; metadataHash: Hex }>("POST", "/vault/slabs", body, a, s),

  // HSP (agent payments)
  hspCheckout: (body: { target: "order" | "swap"; id: Hex; payer: Address }) =>
    request<{ flowId: string; paymentRequestId: string; payTo: Address; amountUsd: string; prepared: HspPrepared }>("/hsp/checkout", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  hspSubmit: (body: { paymentRequestId: string; signature: Hex; payment_payload: unknown; payment_mandate_contents: unknown; cart_hash: string }) =>
    request<{ ok: true }>("/hsp/submit", { method: "POST", body: JSON.stringify(body) }),
};

export interface HspPrepared {
  eip712: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  payment_payload: unknown;
  payment_mandate_contents: unknown;
  cart_hash: string;
  token_total_raw?: string;
}

// ------------------------------------------------------------------ agent

export interface AgentAction {
  type: "order" | "swap" | "hsp_payment";
  [k: string]: unknown;
}

export async function agentChat(body: {
  messages: { role: "user" | "assistant"; content: string }[];
  userAddress?: string;
  limits?: { maxPerOrderUsd?: number; totalBudgetUsd?: number };
}): Promise<{ reply: string; actions: AgentAction[] }> {
  const r = await fetch(`${AGENT_URL}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as { reply?: string; actions?: AgentAction[]; error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? "Agent error");
  return { reply: j.reply ?? "", actions: j.actions ?? [] };
}
