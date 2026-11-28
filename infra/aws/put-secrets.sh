#!/usr/bin/env bash
# Adds service keys to the Secrets Manager secret vaultchain/prod. Run it yourself: it asks for each
# value without echoing it, keeps what is already stored when you press Enter, and generates
# SHIPPING_ENC_KEY (32-byte hex) the first time. Nothing is written to disk.
#   AWS_PROFILE=... ./infra/aws/put-secrets.sh
# Then apply on the host: ./infra/aws/redeploy.sh
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
ID="${SECRET_ID:-vaultchain/prod}"
KEYS=(ANTHROPIC_API_KEY ORACLE_SIGNER_KEY RELAYER_KEY PSA_API_TOKEN EBAY_CLIENT_ID EBAY_CLIENT_SECRET PRICECHARTING_TOKEN VAULT_ADMINS)

CURRENT=$(aws secretsmanager get-secret-value --secret-id "$ID" --query SecretString --output text)
UPDATES="{}"
for k in "${KEYS[@]}"; do
  have=$(CURRENT="$CURRENT" python3 -c "import json,os,sys; print('set' if json.loads(os.environ['CURRENT']).get(sys.argv[1]) else 'empty')" "$k")
  read -r -s -p "$k [$have, Enter to keep]: " v; echo
  if [ -n "$v" ]; then
    UPDATES=$(U="$UPDATES" V="$v" python3 -c "import json,os,sys; d=json.loads(os.environ['U']); d[sys.argv[1]]=os.environ['V']; print(json.dumps(d))" "$k")
  fi
done

NEW=$(CURRENT="$CURRENT" U="$UPDATES" python3 - <<'PY'
import json, os, secrets
d = json.loads(os.environ["CURRENT"]); d.update(json.loads(os.environ["U"]))
d.setdefault("SHIPPING_ENC_KEY", secrets.token_hex(32))
print(json.dumps(d))
PY
)
aws secretsmanager put-secret-value --secret-id "$ID" --secret-string "$NEW" --query VersionId --output text >/dev/null
echo "Updated $ID. Keys now set: $(NEW="$NEW" python3 -c "import json,os; print(', '.join(k for k,v in json.loads(os.environ['NEW']).items() if v))")"
