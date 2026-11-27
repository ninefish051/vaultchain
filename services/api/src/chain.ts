import type { Hex } from "viem";
import {
  ORDER_STATUS,
  SWAP_STATUS,
  fromUsd6,
  swapEscrowAbi,
  vaultEscrowAbi,
  type OrderDto,
  type SwapDto,
} from "@vaultchain/shared";
import { chainContext } from "@vaultchain/chain";

/** Chain access is optional for the API (demo mode runs without deployed contracts). */
export function tryChain() {
  try {
    return chainContext();
  } catch {
    return undefined;
  }
}

const iso = (s: bigint) => (s > 0n ? new Date(Number(s) * 1000).toISOString() : undefined);
const LEG = ["Pending", "Shipped", "Passed"] as const;

export async function readOrder(id: Hex): Promise<OrderDto | undefined> {
  const c = tryChain();
  if (!c) return undefined;
  const o = await c.publicClient.readContract({ address: c.deployment.escrow, abi: vaultEscrowAbi, functionName: "getOrder", args: [id] });
  if (o.status === 0) return undefined;
  return {
    orderId: id,
    buyer: o.buyer,
    seller: o.seller,
    cardKey: o.cardKey,
    slabId: o.slabId,
    priceUsd: fromUsd6(o.priceUsd),
    depositUsd: fromUsd6(o.depositUsd),
    status: ORDER_STATUS[o.status]!,
    deadline: iso(o.deadline),
    fulfillment: o.fulfillment === 1 ? "KeepInVault" : "ShipToBuyer",
    events: [],
  };
}

export async function readSwap(id: Hex): Promise<SwapDto | undefined> {
  const c = tryChain();
  if (!c) return undefined;
  const s = await c.publicClient.readContract({ address: c.deployment.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [id] });
  if (s.status === 0) return undefined;
  return {
    swapId: id,
    partyA: s.legs[0].owner,
    partyB: s.legs[1].owner,
    slabA: s.legs[0].slabId,
    slabB: s.legs[1].slabId,
    cardKeyA: s.legs[0].cardKey,
    cardKeyB: s.legs[1].cardKey,
    depositUsd: fromUsd6(s.depositUsd),
    topUpUsd: fromUsd6(s.topUpUsd),
    topUpFrom: s.topUpFrom as 0 | 1 | 2,
    status: SWAP_STATUS[s.status]!,
    legState: [LEG[s.legState[0]]!, LEG[s.legState[1]]!],
    deadline: iso(s.deadline),
    events: [],
  };
}
