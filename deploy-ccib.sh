#!/usr/bin/env bash
set -Eeuo pipefail

readonly JUMP_HOST="${CCIB_JUMP_HOST:-aboylan@ccibprod0.mgh.harvard.edu}"
readonly TARGET_HOST="${CCIB_TARGET_HOST:-aboylan@clustweb2}"
readonly DEPLOY_DIR="/home/aboylan/flow-cytometry-collator"

exec ssh -J "${JUMP_HOST}" "${TARGET_HOST}" \
  "cd '${DEPLOY_DIR}' && ./deploy.sh"
