import type { Address } from "viem";
import {
  DEMO_CARDS,
  DEMO_LISTINGS,
  demoPriceHistory,
  demoSales,
  demoSnapshot,
  type Listing,
  type Offer,
} from "@vaultchain/shared";
import { filterCards, newId } from "./common";
import type { CardSummary, ListingView, Store, Proposal } from "./types";

/**
 * In-memory store backed by the shared demo catalogue. Used when DATABASE_URL is not set, so the
 * web app and agent can run without infrastructure. Writes live until the process restarts.
 */
export function createDemoStore(): Store {
  const listings = new Map<string, Listing & { status: string }>(DEMO_LISTINGS.map((l) => [l.id, { ...l, status: "active" }]));
  const offers = new Map<string, Offer>();
  const proposals = new Map<string, Proposal>();
  const hsp = new Map<string, { status: string }>();
  const cardByKey = new Map(DEMO_CARDS.map((c) => [c.cardKey, c]));
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  const view = (l: Listing): ListingView => ({ ...l, card: cardByKey.get(l.cardKey)!, price: demoSnapshot(l.cardKey) });

  const store: Store = {
    mode: "demo",
    async listCards(q) {
      const cards: CardSummary[] = DEMO_CARDS.map((c) => {
        const active = [...listings.values()].filter((l) => l.cardKey === c.cardKey && l.status === "active");
        return {
          ...c,
          price: demoSnapshot(c.cardKey),
          listingCount: active.length,
          lowestAskUsd: active.length ? Math.min(...active.map((l) => l.priceUsd)) : undefined,
        };
      });
      return filterCards(cards, q);
    },
    async getCard(cardKey) {
      return cardByKey.get(cardKey);
    },
    async priceSnapshot(cardKey) {
      return demoSnapshot(cardKey);
    },
    async priceHistory(cardKey, days) {
      return demoPriceHistory(cardKey).slice(-days);
    },
    async sales(cardKey, limit) {
      return demoSales(cardKey).slice(0, limit);
    },

    async listListings(q) {
      return [...listings.values()]
        .filter((l) => l.status === "active")
        .filter((l) => (!q.type || l.type === q.type) && (q.acceptsSwap === undefined || l.acceptsSwap === q.acceptsSwap))
        .filter((l) => (!q.cardKey || l.cardKey === q.cardKey) && (!q.seller || eq(l.seller, q.seller)))
        .map(view)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getListing(id) {
      const l = listings.get(id);
      return l ? view(l) : undefined;
    },
    async createListing(n) {
      const l = { ...n, id: newId("lst"), createdAt: new Date().toISOString(), status: "active" };
      listings.set(l.id, l);
      return l;
    },
    async cancelListing(id) {
      const l = listings.get(id);
      if (l) l.status = "cancelled";
    },

    async listOffers(listingId) {
      return [...offers.values()].filter((o) => o.listingId === listingId);
    },
    async createOffer(o) {
      const offer: Offer = { id: newId("ofr"), listingId: o.listingId, buyer: o.buyer, priceUsd: o.priceUsd, status: "open", createdAt: new Date().toISOString() };
      offers.set(offer.id, offer);
      return offer;
    },
    async updateOffer(id, patch) {
      const o = offers.get(id);
      if (!o) return undefined;
      Object.assign(o, patch);
      return o;
    },

    async listProposals(address) {
      return [...proposals.values()].filter((p) => eq(p.proposer, address) || eq(p.counterparty, address));
    },
    async createProposal(p) {
      const sp: Proposal = { ...p, id: newId("prp"), status: "open", createdAt: new Date().toISOString() };
      proposals.set(sp.id, sp);
      return sp;
    },
    async updateProposal(id, status) {
      const p = proposals.get(id);
      if (p) p.status = status;
      return p;
    },
    async getProposal(id) {
      return proposals.get(id);
    },

    async listVaultSwapOffers() {
      return [];
    },
    async listOrders() {
      return [];
    },
    async getOrder() {
      return undefined;
    },
    async listSwaps() {
      return [];
    },
    async getSwap() {
      return undefined;
    },
    async listAssets(owner: Address) {
      // Demo: vault listings owned by this address double as assets.
      return [...listings.values()]
        .filter((l) => l.type === "vault" && eq(l.seller, owner))
        .map((l) => {
          const card = cardByKey.get(l.cardKey)!;
          return { tokenId: l.tokenId!, slabId: l.slabId, cardKey: l.cardKey, owner, custody: "InVault" as const, certNumber: l.certNumber, grader: card.grader };
        });
    },

    async registerSlab() {},
    async recordHspPayment(p) {
      hsp.set(p.paymentRequestId, { status: "created" });
    },
    async hspPayment(id) {
      return hsp.get(id);
    },
    async setHspStatus(id, status) {
      hsp.set(id, { status });
    },
  };
  return store;
}
