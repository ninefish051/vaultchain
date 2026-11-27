/** Mirrors of the Solidity enums (index = on-chain value). */
export const ORDER_STATUS = [
  "None", "Signed", "Locked", "Inspecting", "PaymentWindow", "Disputed", "AwaitingDelivery",
  "Completed", "BuyerDefault", "SellerDefault", "Cancelled", "Refunded", "Returned", "BoughtOut",
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const SWAP_STATUS = [
  "None", "Signed", "Locked", "Inspecting", "Disputed", "AwaitingDelivery", "Completed",
  "Defaulted", "Cancelled", "Refunded",
] as const;
export type SwapStatus = (typeof SWAP_STATUS)[number];

export const CUSTODY = ["None", "InVault", "RedeemLocked", "ExternalSaleLocked"] as const;
export type Custody = (typeof CUSTODY)[number];

export const TERMINAL_ORDER: OrderStatus[] = ["Completed", "SellerDefault", "Cancelled", "Refunded", "Returned", "BoughtOut"];
export const TERMINAL_SWAP: SwapStatus[] = ["Completed", "Defaulted", "Cancelled", "Refunded"];
