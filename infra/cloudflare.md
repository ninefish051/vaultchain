# Frontend on Cloudflare Workers

The marketplace (`apps/web`) runs on Cloudflare Workers through the OpenNext adapter
(`@opennextjs/cloudflare`). The services stay on the EC2 host (see [aws/README.md](aws/README.md)),
because HSP only accepts calls from the allow-listed Elastic IP.

```
vaultchain.example.com        → Cloudflare Worker "vaultchain-web"   (proxied, orange cloud)
api.vaultchain.example.com    → Elastic IP → Caddy → api:4000        (DNS only, grey cloud)
agent.vaultchain.example.com  → Elastic IP → Caddy → agent:4100      (DNS only, grey cloud)
```

`api` and `agent` are DNS only so Caddy keeps issuing their certificates and long agent
requests are not cut by the Cloudflare proxy timeout.

## Files

| File | Purpose |
|---|---|
| `apps/web/wrangler.jsonc` | Worker name, compatibility flags, static assets binding |
| `apps/web/open-next.config.ts` | OpenNext adapter config (defaults; no incremental cache needed, every page is a client component) |
| `apps/web/package.json` | `build:cf`, `preview:cf`, `deploy:cf` |

## Build-time variables

`NEXT_PUBLIC_*` values are inlined into the bundle when it is built, so they must be present in
the build environment, not set as Worker variables.

| Variable | Production value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.<domain>` |
| `NEXT_PUBLIC_AGENT_URL` | `https://agent.<domain>` |
| `NEXT_PUBLIC_CHAIN_ID` | `133` (HSK testnet) or `177` (mainnet) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | from WalletConnect Cloud |

## First deployment

1. **DNS.** Add the domain to Cloudflare and switch the registrar's nameservers to the ones
   Cloudflare gives you (the Route 53 hosted zone is then no longer used). Create two `A` records,
   `api` and `agent`, pointing at the Elastic IP with the proxy **off**.
2. **Log in** from a workstation: `pnpm --filter @vaultchain/web exec wrangler login`.
3. **Deploy:**
   ```bash
   NEXT_PUBLIC_API_URL=https://api.<domain> \
   NEXT_PUBLIC_AGENT_URL=https://agent.<domain> \
   NEXT_PUBLIC_CHAIN_ID=133 \
   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<id> \
   pnpm --filter @vaultchain/web deploy:cf
   ```
   The first deploy prints a `vaultchain-web.<account>.workers.dev` URL.
4. **Custom domain.** Cloudflare dashboard → Workers & Pages → `vaultchain-web` → Settings →
   Domains & Routes → add `<domain>`.
5. **CORS.** On the EC2 host set `CORS_ORIGINS` in `infra/.env` to every origin that loads the
   frontend, for example `https://<domain>,https://vaultchain-web.<account>.workers.dev`, then
   `docker compose --profile app up -d api agent`.
6. **WalletConnect.** Add the same origins to the project's allowed domains in WalletConnect Cloud.

## Later deployments

Either run step 3 again, or connect the GitHub repository in Cloudflare (Workers & Pages →
`vaultchain-web` → Settings → Builds) with root directory `apps/web`, build command
`pnpm build:cf`, deploy command `pnpm exec opennextjs-cloudflare deploy`, and the four variables
above as build variables. Pull requests then get preview URLs; add those to `CORS_ORIGINS` if
they need to reach the API.

## Local check

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @vaultchain/web preview:cf   # http://localhost:8787
```

This runs the built Worker in the local Workers runtime. `pnpm dev:web` is still the normal
development server.
