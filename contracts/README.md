# VaultChain Contracts

Solidity 0.8.28 · Foundry · OpenZeppelin 5.4

| Contract | Purpose |
|---|---|
| `CardPriceOracle` | Fair value + 30-day volatility per card type (`cardKey`), EIP-712 signed by the price service, relayable by anyone. Rejects stale, future-dated and >30% jumps (admin override). |
| `VaultEscrow` | Two-sided escrow order state machine: both sides sign terms (EIP-712), both lock a volatility-sized deposit, vault inspects, buyer pays in full. Defaults are compensated from the defaulter's deposit, including the market move since signing. Accepts USDC via approval, EIP-3009, or HSP Gateway transfers attributed by a relayer. Pull-based payouts. |
| `VaultCardNFT` | ERC-721, one token per graded slab (`tokenId = uint256(keccak256(grader, certNumber))`). Redemption / external-sale locks block transfers until the vault burns the token at handover. |
| `VaultMarket` | Atomic NFT ↔ USDC sale for cards already in the vault. |
| `SwapEscrow` | Card-for-card swap (e.g. PSA 10 ↔ PSA 10) when at least one card is physical. Both sides sign, lock a deposit sized from both cards' volatility (the top-up payer also locks the top-up), ship to the vault, vault inspects each leg, then each side gets the other card as an NFT or shipped out. A vaulted leg is pulled into escrow as an NFT. Non-shipping side compensates the other: `max(5%, move in the value spread)`. |
| `VaultSwap` | Atomic NFT ↔ NFT swap for cards already in the vault, optional USDC top-up. Offer a specific token or "any token of this cardKey". Flat fee per side. |

V1 scope: graded slabs only (PSA / BGS / CGC). No raw-card grading.

## Order flow

```
createOrder ─▶ Signed ─fund×2─▶ Locked ─markShipped─▶ Inspecting ─submitInspection(pass)─▶ PaymentWindow ─fund─▶ Completed / AwaitingDelivery
                 │                 │                       │ fail / timeout                      │ deadline
                 ▼                 ▼                       ▼                                     ▼
             Cancelled       SellerDefault             Disputed ─resolveDispute─▶ Refunded   BuyerDefault ─▶ BoughtOut / Returned
```

### Swap flow (SwapEscrow)

```
createSwap ─▶ Signed ─fund×2 (+top-up, +vaulted NFT)─▶ Locked ─markShipped (each physical leg)─▶ Inspecting ─inspect each leg─▶ Completed / AwaitingDelivery
                 │                                       │ deadline                                │ fail / timeout
                 ▼                                       ▼                                         ▼
             Cancelled                     Defaulted (one missing) / Cancelled (both)           Disputed ─resolveDispute─▶ Refunded
```

Both legs already vaulted → settles as soon as the second side funds (or use `VaultSwap`).

### Formulas

Deposit per side = `clamp(10% + 2 × volatility, 10%, 30%)` of the price (swap: of the higher card value, using the higher volatility).
Default compensation = `max(5% of price, adverse fair-value move × price / refFairValue)`, capped at the deposit.
Swap default compensation = `max(5% of the higher card, (fair_defaulter − ref_defaulter) − (fair_innocent − ref_innocent))`, capped at the deposit.

## Roles

| Role | Contract | Holder |
|---|---|---|
| `ORACLE_SIGNER_ROLE` | Oracle | price service signing key |
| `MINTER_ROLE` | NFT | VaultEscrow, SwapEscrow, vault intake |
| `ESCROW_ROLE` | NFT | VaultEscrow, SwapEscrow (slab locks) |
| `VAULT_ROLE` | NFT, Escrow, SwapEscrow | vault operator |
| `RELAYER_ROLE` | Escrow, SwapEscrow | keeper that confirms HSP payments |
| `ARBITER_ROLE` | Escrow, SwapEscrow | dispute multisig |
| `TREASURY_ROLE` | Escrow | company buyout reserve |
| `DEFAULT_ADMIN_ROLE` | all | deployer → move to a Safe before mainnet |

## Commands

```bash
git submodule update --init --depth 1   # forge-std + OpenZeppelin v5.4.0
forge build
forge test -vv        # 84 tests
# deploy (USDC_ADDRESS empty => deploys MockUSDC for testnets)
cp ../.env.example ../.env   # fill PRIVATE_KEY etc.
source ../.env && forge script script/Deploy.s.sol --rpc-url hsk_testnet --broadcast
```

Addresses are written to `deployments/<chainId>.json`; run `pnpm --filter @vaultchain/shared sync:deployments` (and `pnpm abis` after contract changes) so the services and web app pick them up.

A physical slab can be in only one active order or swap at a time: both escrows reserve it through `VaultCardNFT.lockSlab` (ESCROW_ROLE) and release it when the trade ends. A slab that already exists as a vault NFT cannot go through escrow; it trades as an NFT (VaultMarket / VaultSwap / vaulted swap legs).

Deposits are rounded up to a whole cent (USDC has 6 decimals) so USD-denominated rails such as HSP carts can pay them exactly.
