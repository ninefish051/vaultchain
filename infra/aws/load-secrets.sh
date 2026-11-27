#!/usr/bin/env bash
# Prints KEY=value lines from the AWS Secrets Manager secret `vaultchain/<env>` (a JSON object).
# Runs on the EC2 host with an instance role that may read only that secret.
#   ./aws/load-secrets.sh prod >> .env
set -euo pipefail
ENV_NAME="${1:-prod}"
REGION="${AWS_REGION:-ap-southeast-1}"
aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "vaultchain/${ENV_NAME}" \
  --query SecretString --output text |
  python3 -c 'import json,sys; [print(f"{k}={v}") for k,v in json.load(sys.stdin).items()]'
