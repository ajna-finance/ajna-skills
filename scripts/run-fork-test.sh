#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    exit 1
  fi
}

require_any_env() {
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      return 0
    fi
  done

  echo "Missing required environment variable: one of $*" >&2
  exit 1
}

require_command anvil
require_command cast
require_env AJNA_BASE_FORK_URL
require_env AJNA_TEST_POOL_ADDRESS
require_env AJNA_TEST_BUCKET_INDEX
require_env AJNA_TEST_FUND_AMOUNT_RAW
require_any_env AJNA_TEST_LEND_AMOUNT_WAD AJNA_TEST_LEND_AMOUNT
require_env AJNA_TEST_QUOTE_WHALE
require_env AJNA_TEST_BORROW_LIMIT_INDEX
require_env AJNA_TEST_COLLATERAL_FUND_AMOUNT_RAW
require_env AJNA_TEST_COLLATERAL_AMOUNT_WAD
require_env AJNA_TEST_BORROW_AMOUNT_WAD
require_env AJNA_TEST_COLLATERAL_WHALE
require_env AJNA_TEST_ERC721_TOKEN_ADDRESS
require_env AJNA_TEST_ERC721_TOKEN_ID
require_env AJNA_TEST_ERC721_HOLDER

AJNA_FORK_PORT="${AJNA_FORK_PORT:-9545}"
AJNA_FORK_RPC_URL_BASE="${AJNA_FORK_RPC_URL_BASE:-http://127.0.0.1:${AJNA_FORK_PORT}}"
AJNA_FORK_SIGNER_PRIVATE_KEY="${AJNA_FORK_SIGNER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
ANVIL_ARGS=(
  --fork-url "$AJNA_BASE_FORK_URL"
  --port "$AJNA_FORK_PORT"
  --chain-id 8453
  --silent
)

if [ -n "${AJNA_BASE_FORK_BLOCK_NUMBER:-}" ]; then
  ANVIL_ARGS+=(--fork-block-number "$AJNA_BASE_FORK_BLOCK_NUMBER")
fi

cleanup() {
  if [ -n "${ANVIL_PID:-}" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

anvil "${ANVIL_ARGS[@]}" &
ANVIL_PID=$!

for _ in $(seq 1 30); do
  if cast block-number --rpc-url "$AJNA_FORK_RPC_URL_BASE" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! cast block-number --rpc-url "$AJNA_FORK_RPC_URL_BASE" >/dev/null 2>&1; then
  echo "Anvil fork did not become ready in time" >&2
  exit 1
fi

RUN_AJNA_FORK_TESTS=1 \
AJNA_RPC_URL_BASE="$AJNA_FORK_RPC_URL_BASE" \
AJNA_TEST_LEND_AMOUNT_WAD="${AJNA_TEST_LEND_AMOUNT_WAD:-${AJNA_TEST_LEND_AMOUNT:-}}" \
AJNA_FORK_SIGNER_PRIVATE_KEY="$AJNA_FORK_SIGNER_PRIVATE_KEY" \
npx vitest run tests/fork-execute.test.ts
