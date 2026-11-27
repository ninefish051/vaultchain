import type { CardType, Listing, OrderDto, PricePointSeries, PriceSnapshot, SaleRecord, SwapDto } from "@vaultchain/shared";

/** Thin client for services/api. The agent only reads and quotes; it never signs or pays. */
const API = process.env.API_URL ?? "http://localhost:4000";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`API ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`API ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export type CardSummary = CardType & { price?: PriceSnapshot; listingCount: number; lowestAskUsd?: number };
export type ListingView = Listing & { card: CardType; price?: PriceSnapshot };

export const api = {
  cards: (qs: string) => get<CardSummary[]>(`/cards?${qs}`),
  card: (cardKey: string) =>
    get<{ card: CardType; price?: PriceSnapshot; history: PricePointSeries[]; sales: SaleRecord[]; listings: ListingView[] }>(`/cards/${cardKey}`),
  listings: (qs: string) => get<ListingView[]>(`/listings?${qs}`),
  listing: (id: string) => get<ListingView>(`/listings/${encodeURIComponent(id)}`),
  /** Seller's private floor (service-to-service, needs INTERNAL_TOKEN). Undefined if not set. */
  sellerFloor: async (id: string): Promise<number | undefined> => {
    if (!process.env.INTERNAL_TOKEN) return undefined;
    const r = await fetch(`${API}/internal/listings/${encodeURIComponent(id)}/floor`, {
      headers: { "x-internal-token": process.env.INTERNAL_TOKEN },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return undefined;
    return ((await r.json()) as { floorUsd: number | null }).floorUsd ?? undefined;
  },
  quoteOrder: (cardKey: string, priceUsd: number) =>
    post<{ fairValueUsd: number; volatilityBps: number; depositBps: number; depositUsd: number; deviationPct: number; warnings: string[] }>(
      "/quote/order",
      { cardKey, priceUsd },
    ),
  quoteSwap: (cardKeyA: string, cardKeyB: string) =>
    post<{ fairValueA: number; fairValueB: number; topUpUsd: number; topUpFrom: 0 | 1 | 2; depositUsd: number; depositBps: number }>(
      "/quote/swap",
      { cardKeyA, cardKeyB },
    ),
  order: (id: string) => get<OrderDto>(`/orders/${id}`),
  swap: (id: string) => get<SwapDto>(`/swaps/${id}`),
};
