#!/usr/bin/env bash
# Runs ON the EC2 host (first boot from user data, later through SSM: infra/aws/redeploy.sh).
# Pulls the repo, writes infra/.env from /etc/vaultchain.env + Secrets Manager, and starts the
# services that have what they need:
#   always:            caddy, api, agent, price-indexer
#   oracle-publisher:  ORACLE_SIGNER_KEY set and contracts deployed on CHAIN_ID
#   keeper:            RELAYER_KEY set and contracts deployed on CHAIN_ID
set -euo pipefail

# shellcheck disable=SC1091
source /etc/vaultchain.env
export AWS_REGION
REPO=/opt/vaultchain
cd "$REPO"

if [ "${SKIP_PULL:-}" != "1" ]; then
  git fetch --quiet origin "$REPO_REF"
  git checkout --quiet "$REPO_REF"
  git reset --quiet --hard "origin/$REPO_REF"
  git submodule update --init --recursive --quiet
fi

APP_JSON=$(aws secretsmanager get-secret-value --secret-id "$APP_SECRET_ID" --query SecretString --output text)
DB_JSON=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --query SecretString --output text)

# Build infra/.env: .env.example defaults, then deployment values, then secrets.
APP_JSON="$APP_JSON" DB_JSON="$DB_JSON" python3 - <<'PY'
import json, os, urllib.parse

env = {k: os.environ[k] for k in ("DOMAIN", "CORS_ORIGINS", "CHAIN_ID", "RPC_URL", "AWS_REGION", "EVIDENCE_BUCKET")}
db = json.loads(os.environ["DB_JSON"])
# RDS PostgreSQL 16 enforces TLS. no-verify: encrypted, without pinning the RDS CA (traffic stays in the VPC).
env["DATABASE_URL"] = "postgres://{u}:{p}@{h}:{port}/vaultchain?sslmode=no-verify".format(
    u=urllib.parse.quote(db["username"], safe=""),
    p=urllib.parse.quote(db["password"], safe=""),
    h=os.environ["DB_HOST"], port=os.environ["DB_PORT"])
for k, v in json.loads(os.environ["APP_JSON"]).items():
    if v not in (None, ""):
        env[k] = str(v)

out, seen = [], set()
for line in open("infra/.env.example"):
    key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
    if key in env:
        out.append(f"{key}={env[key]}\n"); seen.add(key)
    else:
        out.append(line)
out += [f"{k}={v}\n" for k, v in env.items() if k not in seen]
fd = os.open("infra/.env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.writelines(out)

deployed = os.environ["CHAIN_ID"] in json.load(open("packages/shared/src/deployments.json"))
svcs = ["caddy", "api", "agent", "price-indexer"]
if deployed and env.get("ORACLE_SIGNER_KEY"): svcs.append("oracle-publisher")
if deployed and env.get("RELAYER_KEY"): svcs.append("keeper")
open("/tmp/vaultchain-services", "w").write(" ".join(svcs))
PY

SERVICES=$(cat /tmp/vaultchain-services)
echo "Starting: $SERVICES"
cd infra
# Build one image at a time: parallel pnpm installs run a 2 GB host out of memory.
export COMPOSE_PARALLEL_LIMIT=1
# shellcheck disable=SC2086
docker compose --profile app build $SERVICES
# shellcheck disable=SC2086
docker compose --profile app up -d --remove-orphans $SERVICES
# stop services that were running before but are no longer eligible
for s in oracle-publisher keeper; do
  case " $SERVICES " in *" $s "*) ;; *) docker compose --profile app stop "$s" 2>/dev/null || true ;; esac
done
docker image prune -f >/dev/null
docker compose --profile app ps
