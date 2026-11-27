import type { Address, Hex } from "viem";
import {
  getCard,
  listCards,
  priceHistory,
  recentSamples,
  snapshot,
  toSaleRecords,
  type Db,
} from "@vaultchain/db";
import type { CardType, Listing, Offer, OrderDto, SwapDto, SwapOfferDto, VaultAsset } from "@vaultchain/shared";
import { filterCards, newId } from "./common";
import type { CardSummary, ListingView, Store, Proposal } from "./types";

const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
const lc = (a: string) => a.toLowerCase();

/* eslint-disable @typescript-eslint/no-explicit-any */
const rowToListing = (r: any): Listing => ({
  id: r.id,
  type: r.type,
  slabId: r.slab_id,
  tokenId: r.token_id ?? undefined,
  cardKey: r.card_key,
  certNumber: r.cert_number,
  seller: r.seller,
  priceUsd: Number(r.price_usd),
  acceptsSwap: r.accepts_swap,
  swapWants: r.swap_wants ?? undefined,
  images: r.images ?? [],
  createdAt: iso(r.created_at)!,
  verified: r.type === "vault" ? true : Boolean(r.verified),
});

const rowToOffer = (r: any): Offer => ({
  id: r.id,
  listingId: r.listing_id,
  buyer: r.buyer,
  priceUsd: Number(r.price_usd),
  counterUsd: n(r.counter_usd),
  status: r.status,
  createdAt: iso(r.created_at)!,
});

const rowToProposal = (r: any): Proposal => ({
  id: r.id,
  kind: r.kind,
  proposer: r.proposer,
  counterparty: r.counterparty,
  terms: r.terms,
  proposerSig: r.proposer_sig,
  status: r.status,
  createdAt: iso(r.created_at)!,
});

export function createPgStore(db: Db): Store {
  const cardCache = new Map<string, CardType>();
  const card = async (key: Hex) => {
    if (!cardCache.has(key)) {
      const c = await getCard(db, key);
      if (c) cardCache.set(key, c);
    }
    return cardCache.get(key);
  };

  async function events(refId: string) {
    const r = await db.query(
      "SELECT event, args, tx_hash, block_time FROM chain_events WHERE ref_id = $1 ORDER BY block_number, log_index",
      [refId],
    );
    return r.rows
      .filter((e) => e.event === "StatusChanged")
      .map((e) => ({ status: e.args.statusName as string, at: iso(e.block_time) ?? "", txHash: e.tx_hash as Hex }));
  }

  const toOrder = async (r: any): Promise<OrderDto> => ({
    orderId: r.order_id,
    buyer: r.buyer,
    seller: r.seller,
    cardKey: r.card_key,
    slabId: r.slab_id,
    priceUsd: Number(r.price_usd),
    depositUsd: Number(r.deposit_usd),
    status: r.status,
    deadline: iso(r.deadline),
    fulfillment: r.fulfillment ?? "KeepInVault",
    events: await events(r.order_id),
  });

  const toSwap = async (r: any): Promise<SwapDto> => ({
    swapId: r.swap_id,
    partyA: r.party_a,
    partyB: r.party_b,
    slabA: r.slab_a,
    slabB: r.slab_b,
    cardKeyA: r.card_key_a,
    cardKeyB: r.card_key_b,
    depositUsd: Number(r.deposit_usd),
    topUpUsd: Number(r.top_up_usd),
    topUpFrom: r.top_up_from,
    status: r.status,
    legState: r.leg_state,
    deadline: iso(r.deadline),
    events: await events(r.swap_id),
  });

  const store: Store = {
    mode: "postgres",

    async listCards(q) {
      const [cards, stats] = await Promise.all([
        listCards(db),
        db.query(
          "SELECT card_key, count(*)::int AS n, min(price_usd) AS lowest FROM listings WHERE status = 'active' GROUP BY card_key",
        ),
      ]);
      const byKey = new Map(stats.rows.map((r) => [r.card_key, r]));
      const out: CardSummary[] = await Promise.all(
        cards.map(async (c) => ({
          ...c,
          price: await snapshot(db, c.cardKey),
          listingCount: byKey.get(c.cardKey)?.n ?? 0,
          lowestAskUsd: n(byKey.get(c.cardKey)?.lowest),
        })),
      );
      return filterCards(out, q);
    },
    getCard: card,
    priceSnapshot: (k) => snapshot(db, k),
    priceHistory: (k, days) => priceHistory(db, k, days),
    async sales(k, limit) {
      return toSaleRecords(await recentSamples(db, k, 90)).slice(0, limit);
    },

    async listListings(q) {
      const where = ["status = 'active'"];
      const args: unknown[] = [];
      if (q.type) where.push(`type = $${args.push(q.type)}`);
      if (q.acceptsSwap !== undefined) where.push(`accepts_swap = $${args.push(q.acceptsSwap)}`);
      if (q.cardKey) where.push(`card_key = $${args.push(q.cardKey)}`);
      if (q.seller) where.push(`seller = $${args.push(lc(q.seller))}`);
      const r = await db.query(`SELECT * FROM listings WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, args);
      return Promise.all(r.rows.map(async (row): Promise<ListingView> => {
        const l = rowToListing(row);
        return { ...l, card: (await card(l.cardKey))!, price: await snapshot(db, l.cardKey) };
      }));
    },
    async getListing(id) {
      const r = await db.query("SELECT * FROM listings WHERE id = $1", [id]);
      if (!r.rows[0]) return undefined;
      const l = rowToListing(r.rows[0]);
      return { ...l, card: (await card(l.cardKey))!, price: await snapshot(db, l.cardKey) };
    },
    async createListing(l) {
      const id = l.type === "vault" && l.tokenId ? `vault-${l.tokenId}` : newId("lst");
      const r = await db.query(
        `INSERT INTO listings (id, type, slab_id, token_id, card_key, cert_number, seller, price_usd, accepts_swap, swap_wants, images, floor_usd, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET price_usd = EXCLUDED.price_usd, accepts_swap = EXCLUDED.accepts_swap, seller = EXCLUDED.seller,
           swap_wants = EXCLUDED.swap_wants, images = EXCLUDED.images, floor_usd = EXCLUDED.floor_usd, verified = EXCLUDED.verified, status = 'active'
         RETURNING *`,
        [id, l.type, l.slabId.toLowerCase(), l.tokenId ?? null, l.cardKey, l.certNumber, lc(l.seller), l.priceUsd, l.acceptsSwap, l.swapWants ?? null,
          JSON.stringify(l.images), l.floorUsd ?? null, l.verified],
      );
      return rowToListing(r.rows[0]);
    },
    async findOpenListingBySlab(slabId) {
      const r = await db.query("SELECT * FROM listings WHERE slab_id = $1 AND status IN ('active','reserved') LIMIT 1", [slabId.toLowerCase()]);
      if (!r.rows[0]) return undefined;
      const l = rowToListing(r.rows[0]);
      return { ...l, status: r.rows[0].status, card: (await card(l.cardKey))!, price: await snapshot(db, l.cardKey) };
    },
    async listingFloor(id) {
      const r = await db.query("SELECT floor_usd FROM listings WHERE id = $1", [id]);
      return n(r.rows[0]?.floor_usd);
    },
    async cancelListing(id) {
      await db.query("UPDATE listings SET status = 'cancelled' WHERE id = $1", [id]);
    },

    async listOffers(listingId) {
      const r = await db.query("SELECT * FROM offers WHERE listing_id = $1 ORDER BY created_at DESC", [listingId]);
      return r.rows.map(rowToOffer);
    },
    async listOffersFor(q) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (q.buyer) where.push("o.buyer = $" + args.push(lc(q.buyer)));
      if (q.seller) where.push("l.seller = $" + args.push(lc(q.seller)));
      const r = await db.query(
        "SELECT o.*, row_to_json(l.*) AS l FROM offers o JOIN listings l ON l.id = o.listing_id " +
          (where.length ? "WHERE " + where.join(" AND ") : "") +
          " ORDER BY o.created_at DESC LIMIT 100",
        args,
      );
      return Promise.all(
        r.rows.map(async (row) => {
          const l = rowToListing(row.l);
          return { ...rowToOffer(row), listing: { ...l, card: (await card(l.cardKey))!, price: await snapshot(db, l.cardKey) } };
        }),
      );
    },
    async createOffer(o) {
      const r = await db.query(
        "INSERT INTO offers (id, listing_id, buyer, price_usd, via_agent) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [newId("ofr"), o.listingId, lc(o.buyer), o.priceUsd, o.viaAgent],
      );
      return rowToOffer(r.rows[0]);
    },
    async updateOffer(id, patch) {
      const r = await db.query(
        "UPDATE offers SET status = COALESCE($2, status), counter_usd = COALESCE($3, counter_usd) WHERE id = $1 RETURNING *",
        [id, patch.status ?? null, patch.counterUsd ?? null],
      );
      return r.rows[0] ? rowToOffer(r.rows[0]) : undefined;
    },

    async listProposals(address) {
      const r = await db.query(
        "SELECT * FROM proposals WHERE proposer = $1 OR counterparty = $1 ORDER BY created_at DESC",
        [lc(address)],
      );
      return r.rows.map(rowToProposal);
    },
    async createProposal(p) {
      const r = await db.query(
        "INSERT INTO proposals (id, kind, proposer, counterparty, terms, proposer_sig) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [newId("prp"), p.kind, lc(p.proposer), lc(p.counterparty), JSON.stringify(p.terms), p.proposerSig],
      );
      return rowToProposal(r.rows[0]);
    },
    async updateProposal(id, status) {
      const r = await db.query("UPDATE proposals SET status = $2 WHERE id = $1 RETURNING *", [id, status]);
      return r.rows[0] ? rowToProposal(r.rows[0]) : undefined;
    },
    async getProposal(id) {
      const r = await db.query("SELECT * FROM proposals WHERE id = $1", [id]);
      return r.rows[0] ? rowToProposal(r.rows[0]) : undefined;
    },

    async listVaultSwapOffers() {
      const r = await db.query(
        `SELECT o.*, a.slab_id AS give_slab, a.card_key AS give_card FROM vault_swap_offers o
         LEFT JOIN assets a ON a.token_id = o.give_token
         WHERE o.status = 'open' AND o.expires_at > now() ORDER BY o.expires_at`,
      );
      return r.rows.map((x): SwapOfferDto => ({
        id: x.offer_id,
        type: "vault",
        maker: x.maker,
        giveSlabId: x.give_slab,
        giveCardKey: x.give_card,
        wantSlabId: x.want_token ? (`0x${BigInt(x.want_token).toString(16).padStart(64, "0")}` as Hex) : undefined,
        wantCardKey: x.want_card_key ?? undefined,
        topUpUsd: Number(x.top_up_usd),
        makerPaysTopUp: x.maker_pays,
        expiresAt: iso(x.expires_at)!,
        status: x.status,
      }));
    },
    async listOrders(address?: Address) {
      const r = address
        ? await db.query("SELECT * FROM orders WHERE buyer = $1 OR seller = $1 ORDER BY updated_at DESC", [lc(address)])
        : await db.query("SELECT * FROM orders ORDER BY updated_at DESC LIMIT 200");
      return Promise.all(r.rows.map(toOrder));
    },
    async getOrder(id) {
      const r = await db.query("SELECT * FROM orders WHERE order_id = $1", [id]);
      return r.rows[0] ? toOrder(r.rows[0]) : undefined;
    },
    async listSwaps(address?: Address) {
      const r = address
        ? await db.query("SELECT * FROM swaps WHERE party_a = $1 OR party_b = $1 ORDER BY updated_at DESC", [lc(address)])
        : await db.query("SELECT * FROM swaps ORDER BY updated_at DESC LIMIT 200");
      return Promise.all(r.rows.map(toSwap));
    },
    async getSwap(id) {
      const r = await db.query("SELECT * FROM swaps WHERE swap_id = $1", [id]);
      return r.rows[0] ? toSwap(r.rows[0]) : undefined;
    },
    async listAssets(owner) {
      const r = await db.query(
        `SELECT a.*, s.cert_number, s.grader FROM assets a LEFT JOIN slabs s ON s.slab_id = a.slab_id
         WHERE a.owner = $1 ORDER BY a.updated_at DESC`,
        [lc(owner)],
      );
      return r.rows.map((x): VaultAsset => ({
        tokenId: x.token_id,
        slabId: x.slab_id,
        cardKey: x.card_key,
        owner: x.owner,
        custody: x.custody,
        certNumber: x.cert_number ?? "",
        grader: x.grader ?? "PSA",
      }));
    },

    async slabInfo(slabId) {
      const r = await db.query("SELECT card_key, grader, cert_number FROM slabs WHERE slab_id = $1", [slabId.toLowerCase()]);
      const x = r.rows[0];
      return x ? { cardKey: x.card_key as Hex, grader: x.grader, certNumber: x.cert_number } : undefined;
    },
    async saveShipping(s) {
      await db.query(
        `INSERT INTO shipping_addresses (target, target_id, wallet, ciphertext) VALUES ($1,$2,$3,$4)
         ON CONFLICT (target, target_id, wallet) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, created_at = now()`,
        [s.target, s.targetId.toLowerCase(), lc(s.wallet), s.ciphertext],
      );
    },
    async shipping(target, targetId) {
      const r = await db.query(
        "SELECT wallet, ciphertext, created_at FROM shipping_addresses WHERE target = $1 AND target_id = $2",
        [target, targetId.toLowerCase()],
      );
      return r.rows.map((x) => ({ wallet: x.wallet as Address, ciphertext: x.ciphertext, createdAt: iso(x.created_at)! }));
    },
    async registerSlab(s) {
      await db.query(
        `INSERT INTO slabs (slab_id, card_key, grader, cert_number, metadata, metadata_hash) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (slab_id) DO UPDATE SET metadata = EXCLUDED.metadata, metadata_hash = EXCLUDED.metadata_hash`,
        [s.slabId, s.cardKey, s.grader, s.certNumber, JSON.stringify(s.metadata), s.metadataHash],
      );
    },
    async recordHspPayment(p) {
      await db.query(
        `INSERT INTO hsp_payments (payment_request_id, flow_id, target, target_id, payer, amount_usd6)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (payment_request_id) DO NOTHING`,
        [p.paymentRequestId, p.flowId, p.target, p.targetId, lc(p.payer), p.amountUsd6.toString()],
      );
    },
    async hspPayment(id) {
      const r = await db.query("SELECT status, record_tx, last_error FROM hsp_payments WHERE payment_request_id = $1", [id]);
      const x = r.rows[0];
      return x ? { status: x.status, recordTx: x.record_tx ?? undefined, lastError: x.last_error ?? undefined } : undefined;
    },
    async setHspStatus(id, status) {
      await db.query("UPDATE hsp_payments SET status = $2, updated_at = now() WHERE payment_request_id = $1", [id, status]);
    },
  };
  return store;
}
