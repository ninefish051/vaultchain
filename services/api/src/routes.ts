import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import {
  depositBpsFor,
  orderDepositUsd,
  slabIdOf,
  suggestTopUp,
  swapDepositUsd,
  swapEscrowAbi,
  vaultEscrowAbi,
  fromUsd6,
  DEFAULT_WINDOWS,
  GRADERS,
} from "@vaultchain/shared";
import { HspClient } from "@vaultchain/hsp";
import { requireSigner, requireVaultAdmin } from "./auth";
import { readOrder, readSwap, tryChain } from "./chain";
import { lookupPsaCert } from "./psa";
import type { Store } from "./store/types";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex);
const address = z.string().refine(isAddress, "invalid address").transform((s) => s.toLowerCase() as Address);
const usd = z.coerce.number().positive().max(10_000_000);

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function registerRoutes(app: FastifyInstance, store: Store) {
  const hsp = new HspClient();

  app.get("/health", async () => ({ ok: true, mode: store.mode, chain: tryChain()?.chainId ?? null }));

  // ------------------------------------------------------------------ catalogue & prices

  app.get("/cards", async (req) => {
    const q = z
      .object({
        q: z.string().optional(),
        grader: z.enum(GRADERS).optional(),
        grade: z.string().optional(),
        minUsd: z.coerce.number().optional(),
        maxUsd: z.coerce.number().optional(),
        sort: z.enum(["price_desc", "price_asc", "change_desc", "change_asc", "name"]).optional(),
      })
      .parse(req.query);
    return store.listCards(q);
  });

  app.get("/cards/:cardKey", async (req) => {
    const { cardKey } = z.object({ cardKey: hex32 }).parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).parse(req.query);
    const card = await store.getCard(cardKey);
    if (!card) throw notFound("card");
    const [price, history, sales, listings] = await Promise.all([
      store.priceSnapshot(cardKey),
      store.priceHistory(cardKey, days),
      store.sales(cardKey, 50),
      store.listListings({ cardKey }),
    ]);
    return { card, price, history, sales, listings };
  });

  // ------------------------------------------------------------------ listings & offers

  app.get("/listings", async (req) => {
    const q = z
      .object({
        type: z.enum(["vault", "escrow"]).optional(),
        acceptsSwap: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
        cardKey: hex32.optional(),
        seller: address.optional(),
      })
      .parse(req.query);
    return store.listListings(q);
  });

  app.get("/listings/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const l = await store.getListing(id);
    if (!l) throw notFound("listing");
    return { ...l, offers: await store.listOffers(id) };
  });

  app.post("/listings", async (req) => {
    const seller = await requireSigner(req);
    const b = z
      .object({
        type: z.enum(["vault", "escrow"]),
        grader: z.enum(GRADERS),
        certNumber: z.string().min(3).max(20),
        cardKey: hex32,
        priceUsd: usd,
        acceptsSwap: z.boolean().default(false),
        swapWants: z.string().max(200).optional(),
        images: z.array(z.string().url()).max(8).default([]),
      })
      .parse(req.body);
    if (!(await store.getCard(b.cardKey))) throw new HttpError(400, "Unknown card type; ask the vault to add it to the catalogue");
    const slabId = slabIdOf(b.grader, b.certNumber);
    return store.createListing({
      type: b.type,
      slabId,
      tokenId: b.type === "vault" ? BigInt(slabId).toString() : undefined,
      cardKey: b.cardKey,
      certNumber: b.certNumber,
      seller,
      priceUsd: b.priceUsd,
      acceptsSwap: b.acceptsSwap,
      swapWants: b.swapWants,
      images: b.images,
    });
  });

  app.delete("/listings/:id", async (req) => {
    const who = await requireSigner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const l = await store.getListing(id);
    if (!l) throw notFound("listing");
    if (l.seller.toLowerCase() !== who.toLowerCase()) throw new HttpError(403, "Only the seller can cancel");
    await store.cancelListing(id);
    return { ok: true };
  });

  app.post("/offers", async (req) => {
    const buyer = await requireSigner(req);
    const b = z.object({ listingId: z.string(), priceUsd: usd, viaAgent: z.boolean().default(false) }).parse(req.body);
    const l = await store.getListing(b.listingId);
    if (!l) throw notFound("listing");
    if (l.seller.toLowerCase() === buyer.toLowerCase()) throw new HttpError(400, "Cannot offer on your own listing");
    return store.createOffer({ ...b, buyer });
  });

  app.post("/offers/:id/respond", async (req) => {
    const who = await requireSigner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({ action: z.enum(["accept", "reject", "counter"]), counterUsd: usd.optional(), listingId: z.string() })
      .parse(req.body);
    const l = await store.getListing(b.listingId);
    if (!l || l.seller.toLowerCase() !== who.toLowerCase()) throw new HttpError(403, "Only the seller can respond");
    const status = b.action === "accept" ? "accepted" : b.action === "reject" ? "rejected" : "countered";
    const o = await store.updateOffer(id, { status, counterUsd: b.counterUsd });
    if (!o) throw notFound("offer");
    return o;
  });

  // ------------------------------------------------------------------ quotes (deposit / swap terms)

  app.post("/quote/order", async (req) => {
    const b = z.object({ cardKey: hex32, priceUsd: usd }).parse(req.body);
    const price = await store.priceSnapshot(b.cardKey);
    if (!price) throw new HttpError(409, "No fair value for this card yet");
    const deviationPct = Math.round(((b.priceUsd - price.fairValueUsd) / price.fairValueUsd) * 10_000) / 100;
    const warnings: string[] = [];
    if (Math.abs(deviationPct) > 40) warnings.push(`Price is ${deviationPct}% from fair value; both sides must confirm`);
    if (Math.abs(deviationPct) > 50) warnings.push("The escrow contract rejects orders more than 50% from fair value");
    if (price.confidence < 40) warnings.push("Low price confidence: few recent sales");
    return {
      fairValueUsd: price.fairValueUsd,
      volatilityBps: price.volatilityBps,
      depositBps: depositBpsFor(price.volatilityBps),
      depositUsd: orderDepositUsd(b.priceUsd, price.volatilityBps),
      deviationPct,
      windows: DEFAULT_WINDOWS,
      warnings,
    };
  });

  app.post("/quote/swap", async (req) => {
    const b = z.object({ cardKeyA: hex32, cardKeyB: hex32 }).parse(req.body);
    const [a, bb] = await Promise.all([store.priceSnapshot(b.cardKeyA), store.priceSnapshot(b.cardKeyB)]);
    if (!a || !bb) throw new HttpError(409, "No fair value for one of the cards");
    return {
      fairValueA: a.fairValueUsd,
      fairValueB: bb.fairValueUsd,
      ...suggestTopUp(a.fairValueUsd, bb.fairValueUsd),
      depositUsd: swapDepositUsd(a.fairValueUsd, bb.fairValueUsd, a.volatilityBps, bb.volatilityBps),
      depositBps: depositBpsFor(Math.max(a.volatilityBps, bb.volatilityBps)),
      windows: DEFAULT_WINDOWS,
    };
  });

  // ------------------------------------------------------------------ swaps

  app.get("/swap-offers", async () => store.listVaultSwapOffers());

  /**
   * Terms signed by one side (EIP-712 OrderTerms or SwapTerms). The counterparty reviews them, signs
   * the same terms and submits createOrder / createSwap on-chain with both signatures.
   */
  app.get("/proposals", async (req) => {
    const { address: a } = z.object({ address }).parse(req.query);
    return store.listProposals(a);
  });

  app.post("/proposals", async (req) => {
    const proposer = await requireSigner(req);
    const b = z
      .object({
        kind: z.enum(["order", "swap"]),
        counterparty: address,
        terms: z.record(z.string(), z.unknown()),
        proposerSig: z.string().regex(/^0x[0-9a-fA-F]+$/),
      })
      .parse(req.body);
    return store.createProposal({ kind: b.kind, proposer, counterparty: b.counterparty, terms: b.terms, proposerSig: b.proposerSig as Hex });
  });

  app.post("/proposals/:id/status", async (req) => {
    const who = await requireSigner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { status } = z.object({ status: z.enum(["accepted", "cancelled"]) }).parse(req.body);
    const p = await store.getProposal(id);
    if (!p) throw notFound("proposal");
    const isParty = [p.proposer, p.counterparty].some((x) => x.toLowerCase() === who.toLowerCase());
    if (!isParty) throw new HttpError(403, "Not a party to this proposal");
    return store.updateProposal(id, status);
  });

  // ------------------------------------------------------------------ orders, swaps, assets (indexed from chain)

  app.get("/orders", async (req) => {
    const { address: a } = z.object({ address: address.optional() }).parse(req.query);
    return store.listOrders(a);
  });
  app.get("/orders/:id", async (req) => {
    const { id } = z.object({ id: hex32 }).parse(req.params);
    const o = (await store.getOrder(id)) ?? (await readOrder(id));
    if (!o) throw notFound("order");
    return o;
  });
  app.get("/swaps", async (req) => {
    const { address: a } = z.object({ address: address.optional() }).parse(req.query);
    return store.listSwaps(a);
  });
  app.get("/swaps/:id", async (req) => {
    const { id } = z.object({ id: hex32 }).parse(req.params);
    const s = (await store.getSwap(id)) ?? (await readSwap(id));
    if (!s) throw notFound("swap");
    return s;
  });
  app.get("/assets", async (req) => {
    const { owner } = z.object({ owner: address }).parse(req.query);
    return store.listAssets(owner);
  });

  // ------------------------------------------------------------------ verification

  app.get("/psa/:cert", async (req) => {
    const { cert } = z.object({ cert: z.string().regex(/^\d{6,12}$/) }).parse(req.params);
    const c = await lookupPsaCert(cert);
    if (!c) throw notFound("PSA certificate");
    return c;
  });

  /** ERC-721 metadata for VaultCardNFT.tokenURI (base URI + 32-byte hex slab id). */
  app.get("/nft/:slabHex", async (req) => {
    const { slabHex } = z.object({ slabHex: z.string() }).parse(req.params);
    const slabId = (slabHex.startsWith("0x") ? slabHex : `0x${slabHex}`).toLowerCase() as Hex;
    const listing = (await store.listListings({})).find((l) => l.slabId.toLowerCase() === slabId);
    const card = listing?.card;
    return {
      name: card ? `${card.name} · ${card.setName} #${card.number} · ${card.grader} ${card.grade}` : `VaultChain slab ${slabId.slice(0, 10)}`,
      description: "A graded trading card held in the VaultChain vault. Redeemable for the physical slab.",
      image: card?.imageUrl,
      attributes: card
        ? [
            { trait_type: "Grader", value: card.grader },
            { trait_type: "Grade", value: card.grade },
            { trait_type: "Set", value: card.setName },
            { trait_type: "Certificate", value: listing?.certNumber },
          ]
        : [],
    };
  });

  // ------------------------------------------------------------------ HSP agent payments

  /**
   * Step 1: create an HSP cart paying the escrow contract for exactly what the payer owes next,
   * and prepare the payment. Returns the EIP-712 data the payer's wallet must sign.
   */
  app.post("/hsp/checkout", async (req) => {
    const b = z.object({ target: z.enum(["order", "swap"]), id: hex32, payer: address }).parse(req.body);
    const c = tryChain();
    if (!c) throw new HttpError(503, "Contracts are not deployed on the configured chain");
    const escrow = b.target === "order" ? c.deployment.escrow : c.deployment.swapEscrow;
    const amount = (await c.publicClient.readContract({
      address: escrow,
      abi: b.target === "order" ? vaultEscrowAbi : swapEscrowAbi,
      functionName: "expectedPayment",
      args: [b.id, b.payer],
    })) as bigint;
    if (amount === 0n) throw new HttpError(409, "Nothing is due from this payer right now");
    if (amount % 10_000n !== 0n) throw new HttpError(409, "Amount is not a whole number of cents");

    const chainConfig = await hsp.getChainConfig();
    const methodData = process.env.HSP_METHOD_DATA_JSON
      ? (JSON.parse(process.env.HSP_METHOD_DATA_JSON) as unknown[])
      : ((chainConfig as { method_data?: unknown[] }).method_data ?? [
          { supported_methods: "https://www.x402.org/", data: { x402Version: 2, ...(chainConfig as object) } },
        ]);
    const amountUsd = fromUsd6(amount).toFixed(2);
    const order = await hsp.createOrder({
      payTo: escrow,
      amountUsd,
      cartId: `${b.target}-${b.id.slice(2, 14)}-${Date.now()}`,
      label: b.target === "order" ? "VaultChain escrow payment" : "VaultChain swap deposit",
      methodData,
    });
    const prepared = await hsp.preparePayment(order.flow_id, b.payer);
    await store.recordHspPayment({
      paymentRequestId: order.payment_request_id,
      flowId: order.flow_id,
      target: b.target,
      targetId: b.id,
      payer: b.payer,
      amountUsd6: amount,
    });
    return { flowId: order.flow_id, paymentRequestId: order.payment_request_id, payTo: escrow, amountUsd, prepared };
  });

  /** Step 2: payer signed the EIP-712 data; finalize and submit. The keeper takes it from here. */
  app.post("/hsp/submit", async (req) => {
    const b = z
      .object({
        paymentRequestId: z.string(),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
        payment_payload: z.unknown(),
        payment_mandate_contents: z.unknown(),
        cart_hash: z.string(),
      })
      .parse(req.body);
    const known = await store.hspPayment(b.paymentRequestId);
    if (!known) throw notFound("HSP payment");
    const { payment_mandate_json } = await hsp.finalizePayment({
      signature: b.signature,
      payment_payload: b.payment_payload,
      payment_mandate_contents: b.payment_mandate_contents,
      cart_hash: b.cart_hash,
    });
    const submitted = await hsp.submitPayment(payment_mandate_json);
    await store.setHspStatus(b.paymentRequestId, "submitted");
    return { ok: true, submitted };
  });

  app.get("/hsp/:paymentRequestId", async (req) => {
    const { paymentRequestId } = z.object({ paymentRequestId: z.string() }).parse(req.params);
    const p = await store.hspPayment(paymentRequestId);
    if (!p) throw notFound("HSP payment");
    return p;
  });

  // ------------------------------------------------------------------ vault back office

  /** Intake: register a physical slab before the operator mints it (mint happens from the operator wallet). */
  app.post("/vault/slabs", async (req) => {
    await requireVaultAdmin(req);
    const b = z
      .object({
        grader: z.enum(GRADERS),
        certNumber: z.string().min(3).max(20),
        cardKey: hex32,
        imageHashes: z.array(z.string()).default([]),
        location: z.string().max(64).optional(),
        psa: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const slabId = slabIdOf(b.grader, b.certNumber);
    const metadata = { grader: b.grader, certNumber: b.certNumber, cardKey: b.cardKey, imageHashes: b.imageHashes, location: b.location, psa: b.psa };
    const metadataHash = keccak256(toBytes(JSON.stringify(metadata)));
    await store.registerSlab({ slabId, cardKey: b.cardKey, grader: b.grader, certNumber: b.certNumber, metadata, metadataHash });
    return { slabId, tokenId: BigInt(slabId).toString(), metadataHash };
  });

  app.get("/vault/queue", async () => {
    const [orders, swaps] = await Promise.all([store.listOrders(), store.listSwaps()]);
    return {
      inspectOrders: orders.filter((o) => o.status === "Inspecting"),
      inspectSwaps: swaps.filter((s) => s.status === "Inspecting"),
      deliveries: [...orders.filter((o) => o.status === "AwaitingDelivery"), ...swaps.filter((s) => s.status === "AwaitingDelivery")],
      disputes: [...orders.filter((o) => o.status === "Disputed"), ...swaps.filter((s) => s.status === "Disputed")],
      returns: orders.filter((o) => o.status === "BuyerDefault"),
    };
  });
}
