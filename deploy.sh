#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "${REPOSITORY_DIR}"
git pull --ff-only origin main

readonly FLOW_COLLATOR_BUILD_TIME="$(date -u "+%Y-%m-%dT%H:%M:%SZ")"
readonly FLOW_COLLATOR_COMMIT_SHA="$(git rev-parse --short=12 HEAD)"
export FLOW_COLLATOR_BUILD_TIME
export FLOW_COLLATOR_COMMIT_SHA

docker compose up \
  --detach \
  --build \
  --remove-orphans \
  --wait \
  --wait-timeout 180
docker compose ps
