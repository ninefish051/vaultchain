# VaultChain

**On-chain escrow and swap marketplace for graded trading cards** (PSA / BGS / CGC slabs).

Platforms that allow no-questions-asked refunds let buyers back out when prices fall and sellers back out when prices rise. VaultChain replaces the refund button with a smart contract:

- **Two-sided deposits.** Buyer and seller each lock a deposit sized from the card's 30-day volatility, `clamp(10% + 2σ, 10%, 30%)`. Whoever walks away compensates the other with at least 5% or the price move since signing.
- **Vault inspection.** Cards ship to a partner vault. The cert is checked against PSA and the inspection result is signed on-chain.
- **Vault NFTs.** Cards that stay in the vault become ERC-721 tokens that can be resold instantly, swapped, or redeemed for the physical slab.
- **Card-for-card swaps.** PSA 10 for PSA 10, with a USDC top-up for the value difference. Atomic when both cards are vaulted; escrowed with deposits when either card is physical.
- **Multi-source fair prices.** eBay (sold and asks), PriceCharting, Carousell and 集换社 are normalized, outlier-filtered and aggregated into a time-weighted median. The result is EIP-712 signed and pushed to an on-chain oracle.
- **Agent payments.** A Claude buyer agent searches, compares, negotiates with seller agents (A2A) and drafts orders. Deposits and payments can be settled through **HSP** (HashKey Settlement Platform) straight into the escrow contract.

Built for the HSK Chain Horizon Hackathon (Seoul), Agent Payments & A2A Settlement track. Technical plan: [docs/技术方案.md](docs/技术方案.md) ([PDF](docs/VaultChain技术方案.pdf)).

## Repository

pnpm workspace monorepo.

```
contracts/                 Foundry · Solidity 0.8.28 · OpenZeppelin 5.4
  src/CardPriceOracle.sol    signed fair value + volatility per card type
  src/VaultEscrow.sol        two-sided escrow sale state machine
  src/SwapEscrow.sol         escrowed card-for-card swap (physical legs)
  src/VaultSwap.sol          atomic NFT ⇄ NFT swap with top-up
  src/VaultCardNFT.sol       one token per vaulted slab; redeem / external-sale locks
  src/VaultMarket.sol        atomic NFT ⇄ USDC sale
apps/web/                  Next.js 15 marketplace + vault back office (wagmi, RainbowKit, Tailwind)
services/
  api/                     Fastify API: catalogue, listings, offers, proposals, quotes, HSP checkout, chain indexer
  price-indexer/           collectors (eBay Browse API, eBay sold scraper, PriceCharting, Carousell) → aggregate
  oracle-publisher/        signs PricePoints (EIP-712) and submits them on-chain
  keeper/                  records HSP payments on-chain; settles expired deadlines
  agent/                   Claude buyer agent (tool use) + rule-based seller agent
packages/
  shared/                  ABIs, chains, CardKey, pricing math, EIP-712 types, demo catalogue
  db/                      Postgres schema, migrations, repository
  chain/                   viem clients for services
  hsp/                     HSP Agentic Payment MCP client
infra/                     Dockerfiles, docker-compose, Caddy, AWS (EC2 + Elastic IP, RDS, Secrets Manager), Cloudflare notes
docs/                      technical plan
```

## Quick start (no infrastructure)

Requirements: Node 22+, pnpm 12, Foundry.

```bash
git clone --recursive git@github.com:ninefish051/vaultchain.git && cd vaultchain
pnpm install
pnpm dev:api     # http://localhost:4000, in-memory demo catalogue when DATABASE_URL is unset
pnpm dev:web     # http://localhost:3000
```

The web app falls back to the built-in demo catalogue if the API is unreachable. Demo prices are synthetic and labelled as such.

### With Postgres and a local chain

```bash
docker compose -f infra/docker-compose.yml --profile localdb up -d postgres
export DATABASE_URL=postgres://vaultchain:vaultchain@localhost:5432/vaultchain
pnpm --filter @vaultchain/db seed:demo

anvil &                                                     # local chain 31337
cd contracts && PRIVATE_KEY=<anvil key> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast && cd ..
pnpm --filter @vaultchain/shared sync:deployments           # copies contracts/deployments/*.json for apps and services
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 pnpm dev:api   # API + chain indexer
NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=true NEXT_PUBLIC_CHAIN_ID=31337 pnpm dev:web
```

Price pipeline and keeper (each in its own terminal):

```bash
pnpm --filter @vaultchain/price-indexer once        # collect + aggregate once
ORACLE_SIGNER_KEY=0x… pnpm --filter @vaultchain/oracle-publisher once
RELAYER_KEY=0x… pnpm --filter @vaultchain/keeper start
ANTHROPIC_API_KEY=… pnpm --filter @vaultchain/agent start
```

## Tests

```bash
cd contracts && forge test          # 84 tests incl. fuzzing of fund conservation, deposit rounding and slab locks
pnpm typecheck && pnpm test         # TypeScript packages (pricing, matching, API, seller agent)
pnpm build                          # Next.js production build
```

End-to-end on a local chain (anvil + Postgres + API with indexer): deploy, sync deployments, start the API with `CHAIN_ID=31337 INDEXER_POLL_MS=1000 PORT=4002`, then

```bash
API_URL=http://localhost:4002 DATABASE_URL=… pnpm --filter @vaultchain/api e2e   # escrow sale + swap, 15 checks
```

## Configuration

See [`.env.example`](.env.example) for contracts and [`infra/.env.example`](infra/.env.example) for services. Secrets (signer keys, API keys) live in AWS Secrets Manager in production and are never committed.

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | api, indexer, publisher, keeper | demo mode without it (api only) |
| `CHAIN_ID`, `RPC_URL` | services | 133 HSK testnet, 177 HSK mainnet |
| `ORACLE_SIGNER_KEY` | oracle-publisher | holds `ORACLE_SIGNER_ROLE` |
| `RELAYER_KEY` | keeper, publisher | holds `RELAYER_ROLE` on both escrows |
| `EBAY_CLIENT_ID/SECRET`, `PRICECHARTING_TOKEN`, `ENABLE_SCRAPERS` | price-indexer | scrapers are off by default |
| `PSA_API_TOKEN` | api | certificate verification; escrow listings are marked unverified without it |
| `SHIPPING_ENC_KEY` | api | 32-byte key, encrypts shipping addresses (AES-256-GCM) |
| `VAULT_SHIPPING_ADDRESS` | api | shown to sellers shipping slabs in for inspection |
| `INTERNAL_TOKEN` | api, agent | lets the seller agent read a listing's private auto-accept floor |
| `HSP_MCP_URL`, `HSP_MERCHANT_NAME` | api, keeper | the server IP must be allow-listed by HSP |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL` | agent | default `claude-haiku-5-5` (cheapest; set `claude-sonnet-5-5` for stronger negotiation) |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_AGENT_URL`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | web | build-time, set where the Cloudflare build runs |
| `CORS_ORIGINS` | api, agent | comma-separated frontend origins (Cloudflare domain and `workers.dev` URL) |

## Deployment

- **Frontend:** Cloudflare Workers (OpenNext adapter), DNS on Cloudflare. See [infra/cloudflare.md](infra/cloudflare.md).
- **Services:** AWS ap-southeast-2 (Sydney; the organization SCP allows only this region): one EC2 instance with an Elastic IP (allow-listed by HSP) running `infra/docker-compose.yml`, RDS Postgres, Secrets Manager and CloudWatch Logs. See [infra/aws/README.md](infra/aws/README.md).

## Status

- Contracts: complete with tests; not yet deployed to HSK testnet or mainnet.
- HSP: client and checkout/keeper flow are implemented against the published guide. Argument names must be checked against the live tool schemas (`pnpm --filter @vaultchain/hsp tools`) from the allow-listed server.
- Price collectors: eBay Browse and PriceCharting need API keys. The eBay sold and Carousell scrapers depend on page markup and need verification before they are enabled.
