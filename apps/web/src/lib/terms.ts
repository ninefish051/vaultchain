import { keccak256, toBytes, type Address, type Hex } from "viem";
import {
  DEFAULT_WINDOWS,
  escrowDomain,
  orderTermsTypes,
  swapEscrowDomain,
  swapTermsTypes,
  toUsd6,
  type LegMessage,
  type OrderTermsMessage,
  type SwapTermsMessage,
} from "@vaultchain/shared";

/** Builds, serializes and prepares EIP-712 payloads for escrow orders and swaps. */

const randomNonce = () => {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(b[0]!) << 32n) | BigInt(b[1]!);
};
const deadline = (hours: number) => BigInt(Math.floor(Date.now() / 1000) + hours * 3600);

export const metadataHashOf = (o: { cardKey: Hex; certNumber: string }) =>
  keccak256(toBytes(JSON.stringify({ cardKey: o.cardKey, certNumber: o.certNumber })));

export function buildOrderTerms(o: {
  buyer: Address;
  seller: Address;
  cardKey: Hex;
  slabId: Hex;
  certNumber: string;
  priceUsd: number;
  keepInVault: boolean;
}): OrderTermsMessage {
  return {
    buyer: o.buyer,
    seller: o.seller,
    cardKey: o.cardKey,
    slabId: o.slabId,
    metadataHash: metadataHashOf(o),
    priceUsd: toUsd6(o.priceUsd),
    ...DEFAULT_WINDOWS,
    fulfillment: o.keepInVault ? 1 : 0,
    nonce: randomNonce(),
    signDeadline: deadline(72),
  };
}

export function buildLeg(o: { owner: Address; cardKey: Hex; slabId: Hex; certNumber: string; vaulted: boolean; counterpartyKeepsInVault: boolean }): LegMessage {
  return {
    owner: o.owner,
    cardKey: o.cardKey,
    slabId: o.slabId,
    metadataHash: metadataHashOf(o),
    kind: o.vaulted ? 1 : 0,
    delivery: o.counterpartyKeepsInVault ? 1 : 0,
  };
}

export function buildSwapTerms(a: LegMessage, b: LegMessage, topUpUsd: number, topUpFrom: 0 | 1 | 2): SwapTermsMessage {
  const { payWindow: _unused, ...w } = DEFAULT_WINDOWS;
  return { a, b, topUpUsd: toUsd6(topUpUsd), topUpFrom: topUpUsd > 0 ? topUpFrom : 0, ...w, nonce: randomNonce(), signDeadline: deadline(72) };
}

export const orderTypedData = (chainId: number, escrow: Address, message: OrderTermsMessage) =>
  ({ domain: escrowDomain(chainId, escrow), types: orderTermsTypes, primaryType: "OrderTerms", message }) as const;

export const swapTypedData = (chainId: number, swapEscrow: Address, message: SwapTermsMessage) =>
  ({ domain: swapEscrowDomain(chainId, swapEscrow), types: swapTermsTypes, primaryType: "SwapTerms", message }) as const;

/** JSON-safe form for the API (bigints → strings) and back. */
export const toJson = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)));
export function fromJson<T>(v: Record<string, unknown>): T {
  return JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === "string" && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as T;
}
