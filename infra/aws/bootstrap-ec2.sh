#!/usr/bin/env bash
# One-time setup on a fresh Amazon Linux 2023 / Ubuntu EC2 instance (run as a sudo user).
# Installs Docker + compose plugin and checks out the repo. Does not create any AWS resources.
set -euo pipefail

if command -v dnf >/dev/null; then
  sudo dnf install -y docker git python3 awscli
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
else
  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git python3 awscli
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

echo "Public IP (give this Elastic IP to HSP for the allow-list):"
curl -fsS https://checkip.amazonaws.com
echo "Next: git clone --recursive <repo> && cd vaultchain/infra && cp .env.example .env && ./aws/load-secrets.sh prod >> .env && docker compose --profile app up -d --build"
