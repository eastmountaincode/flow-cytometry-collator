#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "${REPOSITORY_DIR}"
git pull --ff-only origin main

docker compose up \
  --detach \
  --build \
  --remove-orphans \
  --wait \
  --wait-timeout 180
docker compose ps
