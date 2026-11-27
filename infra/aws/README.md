# AWS deployment (ap-southeast-1)

Hackathon / v1 topology: one EC2 host running Docker Compose behind an Elastic IP. The Elastic IP matters: HSP only accepts MCP calls from allow-listed IPs.

| Resource | Purpose | Notes |
|---|---|---|
| EC2 `t3.medium` (Amazon Linux 2023) | all services via `infra/docker-compose.yml` | instance role: read `vaultchain/*` secret, write CloudWatch Logs |
| Elastic IP | stable egress IP for HSP allow-list + DNS | report it to HSP before integration |
| RDS PostgreSQL 16 (`db.t4g.micro`) | `DATABASE_URL` | private subnet, SG allows 5432 from the EC2 SG only |
| Secrets Manager `vaultchain/prod` | JSON: `ORACLE_SIGNER_KEY`, `RELAYER_KEY`, `ANTHROPIC_API_KEY`, `EBAY_*`, `PRICECHARTING_TOKEN`, `PSA_API_TOKEN`, `SHIPPING_ENC_KEY`, `INTERNAL_TOKEN` | loaded by `load-secrets.sh` |
| S3 `vaultchain-evidence` | price evidence snapshots, inspection photos | optional for the demo |
| CloudWatch Logs `/vaultchain/prod` | container logs (awslogs driver) | |
| Route 53 | `DOMAIN`, `api.DOMAIN`, `agent.DOMAIN` → Elastic IP | Caddy issues TLS certificates |

Security group (EC2): inbound 80/443 from anywhere, 22 from your IP only (or use SSM Session Manager and close 22).

## Steps

1. Create the resources above (console, or ask Claude with the AWS MCP once credentials are configured).
2. `ssh` into the instance, run `infra/aws/bootstrap-ec2.sh`, note the printed IP and send it to HSP.
3. `cd infra && cp .env.example .env`, edit `DOMAIN`, `DATABASE_URL` (RDS), `CHAIN_ID`, `RPC_URL`.
4. `./aws/load-secrets.sh prod >> .env`
5. `docker compose --profile app up -d --build`
6. Deploy contracts from a workstation (`contracts/README.md`), then `pnpm --filter @vaultchain/shared sync:deployments`, commit, and redeploy.

Keys: the oracle signer and relayer keys should be separate low-balance hot wallets; the contract admin stays in a Safe.
