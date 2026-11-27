import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { api } from "./api";
import { respondToOffer } from "./sellerAgent";

/**
 * Buyer agent: finds cards, checks fair value against multi-source sales, negotiates with seller
 * agents (A2A), and drafts escrow orders / swaps / HSP payments.
 *
 * It never signs or pays. Anything that moves money becomes an `action` the web app renders as a
 * confirmation card; the user's wallet signs it. A user may set spending limits; the agent refuses
 * to draft anything above them.
 *
 * Runs on the Messages API (tool runner) on our own server rather than Managed Agents because HSP
 * only accepts calls from an allow-listed IP (the EC2 Elastic IP).
 */

export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";

export interface Limits {
  maxPerOrderUsd?: number;
  /** Budget for the whole session. */
  totalBudgetUsd?: number;
  /** Already committed earlier in this session (sum of drafts the user saw), sent by the client. */
  spentUsd?: number;
  allowedGraders?: string[];
}

export type AgentAction =
  | { type: "order"; listingId: string; cardKey: string; priceUsd: number; depositUsd: number; fulfillment: "KeepInVault" | "ShipToBuyer"; warnings: string[] }
  | { type: "swap"; myListingId?: string; theirListingId: string; topUpUsd: number; topUpFrom: 0 | 1 | 2; depositUsd: number }
  | { type: "hsp_payment"; target: "order" | "swap"; id: string; note: string };

const SYSTEM = `You are VaultChain's buyer agent. VaultChain is a marketplace for graded trading cards (PSA / BGS / CGC slabs only; raw cards are not supported).
Trades settle through on-chain escrow: buyer and seller each lock a deposit sized from the card's price volatility; whoever defaults compensates the other. Cards can also be swapped card-for-card with a USDC top-up.

How you work:
- Ground every price claim in tool results (fair value, recent sales with source and date, confidence). Say when confidence is low or data is thin.
- Compare the ask with the fair value and with recent sold prices before recommending a price.
- Negotiate through negotiate_with_seller_agent before drafting an order when the ask is above fair value.
- Stay within the user's limits. If something would exceed them, say so and ask instead of drafting.
- draft_order, draft_swap and request_hsp_payment only prepare a confirmation card for the user. Nothing is signed or paid until the user approves it in their wallet. Tell the user that.
- Keep replies short: what you found, what you recommend, and the next step. Use USD.`;

export async function runBuyerAgent(input: {
  messages: Anthropic.Beta.BetaMessageParam[];
  userAddress?: string;
  limits?: Limits;
}): Promise<{ reply: string; actions: AgentAction[]; stopReason: string | null }> {
  const client = new Anthropic();
  const actions: AgentAction[] = [];
  const limits = input.limits ?? {};

  // Spending already drafted this session (client-reported) plus what this turn drafts.
  let committed = limits.spentUsd ?? 0;
  const withinLimits = (usd: number) => {
    if (limits.maxPerOrderUsd !== undefined && usd > limits.maxPerOrderUsd) return `exceeds the per-order limit of $${limits.maxPerOrderUsd}`;
    if (limits.totalBudgetUsd !== undefined && committed + usd > limits.totalBudgetUsd) {
      return `would bring session spending to $${(committed + usd).toFixed(2)}, above the budget of $${limits.totalBudgetUsd}`;
    }
    return undefined;
  };

  const tools = [
    betaZodTool({
      name: "search_catalog",
      description: "Search the VaultChain catalogue of graded card types with current fair value, 24h/30d change and number of active listings.",
      inputSchema: z.object({
        query: z.string().describe("Card name, set or number, e.g. 'charizard base set'"),
        grader: z.enum(["PSA", "BGS", "CGC"]).optional(),
        grade: z.string().optional().describe("e.g. '10' or '9.5'"),
        maxUsd: z.number().optional(),
      }),
      run: async ({ query, grader, grade, maxUsd }) => {
        const qs = new URLSearchParams({ q: query });
        if (grader) qs.set("grader", grader);
        if (grade) qs.set("grade", grade);
        if (maxUsd) qs.set("maxUsd", String(maxUsd));
        const cards = await api.cards(qs.toString());
        return JSON.stringify(
          cards.slice(0, 12).map((c) => ({
            cardKey: c.cardKey,
            card: `${c.name} · ${c.setName} #${c.number} · ${c.grader} ${c.grade}`,
            fairValueUsd: c.price?.fairValueUsd,
            change24hPct: c.price?.change24hPct,
            change30dPct: c.price?.change30dPct,
            confidence: c.price?.confidence,
            activeListings: c.listingCount,
            lowestAskUsd: c.lowestAskUsd,
          })),
        );
      },
    }),
    betaZodTool({
      name: "get_price",
      description: "Fair value, 30-day volatility, confidence and the most recent individual sales (source, price, date) for one card type.",
      inputSchema: z.object({ cardKey: z.string() }),
      run: async ({ cardKey }) => {
        const d = await api.card(cardKey);
        const h = d.history;
        return JSON.stringify({
          card: `${d.card.name} · ${d.card.setName} #${d.card.number} · ${d.card.grader} ${d.card.grade}`,
          price: d.price,
          range90d: h.length ? { min: Math.min(...h.map((p) => p.fairValueUsd)), max: Math.max(...h.map((p) => p.fairValueUsd)) } : null,
          recentSales: d.sales.slice(0, 12).map((s) => ({ source: s.source, kind: s.kind, priceUsd: s.priceUsd, at: s.observedAt.slice(0, 10) })),
        });
      },
    }),
    betaZodTool({
      name: "compare_listings",
      description: "All active VaultChain listings for a card type (vault = instant settlement, escrow = seller ships for inspection) plus external asks seen on eBay/Carousell.",
      inputSchema: z.object({ cardKey: z.string() }),
      run: async ({ cardKey }) => {
        const d = await api.card(cardKey);
        return JSON.stringify({
          fairValueUsd: d.price?.fairValueUsd,
          vaultchain: d.listings.map((l) => ({ listingId: l.id, type: l.type, askUsd: l.priceUsd, acceptsSwap: l.acceptsSwap, cert: l.certNumber })),
          externalAsks: d.sales.filter((s) => s.kind === "listing").slice(0, 8).map((s) => ({ source: s.source, askUsd: s.priceUsd, at: s.observedAt.slice(0, 10) })),
        });
      },
    }),
    betaZodTool({
      name: "negotiate_with_seller_agent",
      description: "Send an offer to the seller's agent for a listing. Returns accept, counter (with price) or reject.",
      inputSchema: z.object({ listingId: z.string(), offerUsd: z.number().positive() }),
      run: async ({ listingId, offerUsd }) => {
        const [l, floor] = await Promise.all([api.listing(listingId), api.sellerFloor(listingId)]);
        return JSON.stringify(respondToOffer({ askUsd: l.priceUsd, fairValueUsd: l.price?.fairValueUsd, sellerFloorUsd: floor }, offerUsd));
      },
    }),
    betaZodTool({
      name: "draft_order",
      description:
        "Prepare an escrow purchase for the user to confirm (shows price, deposit and deadlines). Does not sign or pay. Use the agreed price from negotiation.",
      inputSchema: z.object({
        listingId: z.string(),
        priceUsd: z.number().positive(),
        keepInVault: z.boolean().describe("true: keep the card in the vault as an NFT; false: ship it to the buyer"),
      }),
      run: async ({ listingId, priceUsd, keepInVault }) => {
        const over = withinLimits(priceUsd);
        if (over) return `Not drafted: $${priceUsd} ${over}. Ask the user before going further.`;
        const l = await api.listing(listingId);
        if (limits.allowedGraders?.length && !limits.allowedGraders.includes(l.card.grader)) return `Not drafted: ${l.card.grader} is outside the user's allowed graders.`;
        const q = await api.quoteOrder(l.cardKey, priceUsd);
        committed += priceUsd;
        actions.push({ type: "order", listingId, cardKey: l.cardKey, priceUsd, depositUsd: q.depositUsd, fulfillment: keepInVault ? "KeepInVault" : "ShipToBuyer", warnings: q.warnings });
        return JSON.stringify({ drafted: true, depositUsd: q.depositUsd, depositPct: q.depositBps / 100, deviationFromFairPct: q.deviationPct, warnings: q.warnings });
      },
    }),
    betaZodTool({
      name: "find_swap_match",
      description: "Find listings whose owners accept card-for-card swaps, optionally of a specific card type, with the suggested USDC top-up versus the user's card.",
      inputSchema: z.object({ myCardKey: z.string(), wantCardKey: z.string().optional() }),
      run: async ({ myCardKey, wantCardKey }) => {
        const qs = new URLSearchParams({ acceptsSwap: "true" });
        if (wantCardKey) qs.set("cardKey", wantCardKey);
        const ls = (await api.listings(qs.toString())).filter((l) => l.cardKey !== myCardKey || wantCardKey).slice(0, 8);
        const out = [];
        for (const l of ls) {
          const q = await api.quoteSwap(myCardKey, l.cardKey);
          out.push({ listingId: l.id, card: `${l.card.name} ${l.card.grader} ${l.card.grade}`, type: l.type, theirFairUsd: q.fairValueB, myFairUsd: q.fairValueA, topUpUsd: q.topUpUsd, whoPays: q.topUpFrom === 1 ? "you" : q.topUpFrom === 2 ? "them" : "nobody", depositUsd: q.depositUsd, wants: l.swapWants });
        }
        return JSON.stringify(out);
      },
    }),
    betaZodTool({
      name: "draft_swap",
      description: "Prepare a card-for-card swap proposal for the user to sign. Top-up defaults to the fair-value difference.",
      inputSchema: z.object({ myCardKey: z.string(), myListingId: z.string().optional(), theirListingId: z.string(), topUpUsd: z.number().min(0).optional() }),
      run: async ({ myCardKey, myListingId, theirListingId, topUpUsd }) => {
        const l = await api.listing(theirListingId);
        const q = await api.quoteSwap(myCardKey, l.cardKey);
        const topUp = topUpUsd ?? q.topUpUsd;
        if (q.topUpFrom === 1) {
          const over = withinLimits(topUp + q.depositUsd);
          if (over) return `Not drafted: top-up plus deposit ${over}.`;
        }
        if (q.topUpFrom === 1) committed += topUp;
        actions.push({ type: "swap", myListingId, theirListingId, topUpUsd: topUp, topUpFrom: topUp === 0 ? 0 : q.topUpFrom, depositUsd: q.depositUsd });
        return JSON.stringify({ drafted: true, topUpUsd: topUp, whoPays: q.topUpFrom === 1 ? "you" : "them", depositUsd: q.depositUsd });
      },
    }),
    betaZodTool({
      name: "request_hsp_payment",
      description: "Ask the user to pay what is due on an existing order or swap (deposit or final payment) through HSP. The user approves and signs in their wallet.",
      inputSchema: z.object({ target: z.enum(["order", "swap"]), id: z.string(), note: z.string() }),
      run: async ({ target, id, note }) => {
        actions.push({ type: "hsp_payment", target, id, note });
        return "Payment request shown to the user for approval.";
      },
    }),
    betaZodTool({
      name: "get_order_status",
      description: "Current status, deposit, and next deadline of an escrow order or swap.",
      inputSchema: z.object({ kind: z.enum(["order", "swap"]), id: z.string() }),
      run: async ({ kind, id }) => JSON.stringify(kind === "order" ? await api.order(id) : await api.swap(id)),
    }),
  ];

  const context = [
    input.userAddress ? `User wallet: ${input.userAddress}` : "User wallet: not connected",
    `Limits: ${JSON.stringify(limits)}`,
  ].join("\n");

  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 12,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools,
    messages: [...input.messages, { role: "user", content: [{ type: "text", text: `<session>\n${context}\n</session>` }] }],
  });

  if (final.stop_reason === "refusal") {
    return { reply: "Sorry, I can't help with that request.", actions: [], stopReason: final.stop_reason };
  }
  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { reply, actions, stopReason: final.stop_reason };
}
