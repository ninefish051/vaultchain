/**
 * Seller agent: answers buyer-agent offers on behalf of a seller (A2A negotiation).
 * Deterministic on purpose: a seller sets a floor and the agent never goes below it.
 *   floor  = sellerFloorUsd ?? max(95% of ask, 97% of fair value)
 *   offer >= floor        → accept
 *   offer >= 85% of floor → counter halfway between offer and ask (never below floor)
 *   otherwise             → reject
 */
export interface SellerPolicy {
  askUsd: number;
  fairValueUsd?: number;
  sellerFloorUsd?: number;
}

export type SellerReply =
  | { decision: "accept"; priceUsd: number; reason: string }
  | { decision: "counter"; priceUsd: number; reason: string }
  | { decision: "reject"; reason: string };

const round = (x: number) => Math.round(x * 100) / 100;

export function sellerFloor(p: SellerPolicy): number {
  if (p.sellerFloorUsd) return p.sellerFloorUsd;
  return round(Math.max(p.askUsd * 0.95, (p.fairValueUsd ?? 0) * 0.97));
}

export function respondToOffer(p: SellerPolicy, offerUsd: number): SellerReply {
  const floor = sellerFloor(p);
  if (offerUsd >= floor) return { decision: "accept", priceUsd: round(offerUsd), reason: "Offer meets the seller's floor" };
  if (offerUsd >= floor * 0.85) {
    const counter = round(Math.max(floor, (offerUsd + p.askUsd) / 2));
    return { decision: "counter", priceUsd: counter, reason: `Seller counters at $${counter}` };
  }
  return { decision: "reject", reason: "Offer is too far below the seller's floor" };
}
