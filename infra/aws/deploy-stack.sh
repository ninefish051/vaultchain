#!/usr/bin/env bash
# Creates or updates the VaultChain AWS stack (infra/aws/vaultchain.yaml) from a workstation.
#   AWS_PROFILE=... ./infra/aws/deploy-stack.sh
# Optional env: STACK (vaultchain), AWS_REGION (ap-southeast-2), DOMAIN, CORS_ORIGINS, CHAIN_ID, RPC_URL, REPO_REF
set -euo pipefail
cd "$(dirname "$0")"
STACK="${STACK:-vaultchain}"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
DOMAIN="${DOMAIN:-vaultchain.asia}"
CORS_ORIGINS="${CORS_ORIGINS:-https://${DOMAIN},https://www.${DOMAIN}}"

# RDS needs a full engine version. Resolve it only on first create; afterwards keep the stack's
# value (auto minor upgrades move the instance forward, and CloudFormation must not downgrade it).
EXTRA=()
if ! aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  PGV=$(aws rds describe-db-engine-versions --engine postgres --engine-version 16 --default-only \
    --query 'DBEngineVersions[0].EngineVersion' --output text)
  echo "PostgreSQL engine version: $PGV"
  EXTRA+=("DbEngineVersion=${PGV}")
fi

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file vaultchain.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "Domain=${DOMAIN}" \
    "CorsOrigins=${CORS_ORIGINS}" \
    "ChainId=${CHAIN_ID:-133}" \
    "RpcUrl=${RPC_URL:-https://testnet.hsk.xyz}" \
    "RepoRef=${REPO_REF:-main}" \
    ${EXTRA[@]+"${EXTRA[@]}"}

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
