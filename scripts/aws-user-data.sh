#!/bin/bash
set -euxo pipefail

exec > >(tee /var/log/cinemaseat-bootstrap.log) 2>&1

dnf install -y docker git curl
systemctl enable --now docker

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

mkdir -p /usr/local/lib/docker/cli-plugins
curl --fail --location --retry 5 \
  https://github.com/docker/compose/releases/download/v2.40.3/docker-compose-linux-x86_64 \
  --output /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

git clone --depth 1 https://github.com/towhid146/cinemaseat.git /opt/cinemaseat
cat > /opt/cinemaseat/.env <<'ENVIRONMENT'
FRONTEND_PORT=80
HOLD_TTL_SECONDS=10
HOLD_SWEEP_INTERVAL_MS=1000
ENVIRONMENT

cd /opt/cinemaseat
docker compose up -d --build --remove-orphans
