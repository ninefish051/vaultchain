#!/usr/bin/env bash
# Creates the two service hot wallets (oracle signer, relayer) and stores their private keys
# straight into the Secrets Manager secret vaultchain/prod. Only the addresses are printed:
# the keys never touch disk or the terminal. Existing keys are kept unless FORCE=1.
#   AWS_PROFILE=vaultchain ./infra/aws/create-hot-wallets.sh
# Needs Foundry's `cast`. Keep only a little gas on these wallets.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
ID="${SECRET_ID:-vaultchain/prod}"
command -v cast >/dev/null || { echo "cast not found: install Foundry first (foundryup)"; exit 1; }

CURRENT=$(aws secretsmanager get-secret-value --secret-id "$ID" --query SecretString --output text)
NEW=$(CURRENT="$CURRENT" FORCE="${FORCE:-0}" python3 - <<'PY'
import json, os, subprocess
d = json.loads(os.environ["CURRENT"])
for k in ("ORACLE_SIGNER_KEY", "RELAYER_KEY"):
    if d.get(k) and os.environ["FORCE"] != "1":
        continue
    out = json.loads(subprocess.check_output(["cast", "wallet", "new", "--json"]))
    w = (out["data"] if isinstance(out, dict) else out)[0]   # Foundry >= 1.x nests under "data"
    d[k] = w["private_key"]
print(json.dumps(d))
PY
)
aws secretsmanager put-secret-value --secret-id "$ID" --secret-string "$NEW" --query VersionId --output text >/dev/null
NEW="$NEW" python3 - <<'PY'
import json, os, subprocess
d = json.loads(os.environ["NEW"])
for k, label in (("ORACLE_SIGNER_KEY", "ORACLE_SIGNER_ADDRESS"), ("RELAYER_KEY", "RELAYER_ADDRESS")):
    addr = subprocess.check_output(["cast", "wallet", "address", "--private-key", d[k]], text=True).strip()
    print(f"{label}={addr}")
PY
