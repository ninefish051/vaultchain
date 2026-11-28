#!/usr/bin/env bash
# Creates three testnet-only wallets for the end-to-end check (buyer, seller, test vault operator)
# and keeps their keys in the Secrets Manager secret vaultchain/e2e. Only addresses are printed.
# Re-running keeps the existing wallets. Never fund these with anything but testnet gas.
#   AWS_PROFILE=vaultchain ./infra/aws/create-e2e-wallets.sh
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
ID="${SECRET_ID:-vaultchain/e2e}"
CAST="${CAST:-$(command -v cast || echo "$HOME/.foundry/bin/cast")}"

if CURRENT=$(aws secretsmanager get-secret-value --secret-id "$ID" --query SecretString --output text 2>/dev/null); then
  CREATE=0
else
  CURRENT="{}"; CREATE=1
fi
NEW=$(CURRENT="$CURRENT" CAST="$CAST" python3 - <<'PY'
import json, os, subprocess
d = json.loads(os.environ["CURRENT"])
for k in ("BUYER_KEY", "SELLER_KEY", "VAULT_KEY"):
    if not d.get(k):
        out = json.loads(subprocess.check_output([os.environ["CAST"], "wallet", "new", "--json"]))
        d[k] = (out["data"] if isinstance(out, dict) else out)[0]["private_key"]
print(json.dumps(d))
PY
)
if [ "$CREATE" = 1 ]; then
  aws secretsmanager create-secret --name "$ID" --description "VaultChain testnet e2e wallets (no real value)" \
    --secret-string "$NEW" --query Name --output text >/dev/null
else
  aws secretsmanager put-secret-value --secret-id "$ID" --secret-string "$NEW" --query VersionId --output text >/dev/null
fi
NEW="$NEW" CAST="$CAST" python3 - <<'PY'
import json, os, subprocess
d = json.loads(os.environ["NEW"])
for k in ("BUYER", "SELLER", "VAULT"):
    a = subprocess.check_output([os.environ["CAST"], "wallet", "address", "--private-key", d[k + "_KEY"]], text=True).strip()
    print(f"E2E_{k}={a}")
PY
