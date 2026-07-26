#!/usr/bin/env bash
#
# Phase 1 exit-gate smoke test (spec §10):
#   register a stagenet account -> receive stagenet XMR -> observe via /get_address_txs.
#
# Usage:
#   scripts/smoke-test-monero.sh <address> <viewkey>
#
# Prerequisites:
#   - the monero docker stack (monerod + monero-lws) brought up via the `monero` profile
#   - monerod fully synced to stagenet tip (sndev monero status -> height near target)
#   - a stagenet wallet whose address + private view key you pass as arguments
#   - access to a stagenet faucet (URLs printed below) to send test XMR
#
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <stagenet_address> <stagenet_viewkey>" >&2
  exit 2
fi

ADDRESS="$1"
VIEWKEY="$2"
POLL_INTERVAL=30
TIMEOUT=600

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Phase 1 smoke test: register -> send -> observe ==="
echo "  address: $ADDRESS"
echo

echo "[1/4] Starting monero stack (monerod + monero-lws)..."
./sndev compose --profile monero up -d monerod monero-lws
echo

echo "[2/4] Registering account with monero-lws via sndev monero add_account..."
./sndev monero add_account "$ADDRESS" "$VIEWKEY"
echo

echo "[3/4] Send stagenet XMR to the address above (any amount >= 0.0001 XMR):"
./sndev monero faucet "$ADDRESS"
echo
echo "    >>> After sending, this script polls for the transaction."
echo "    >>> Waiting up to $((TIMEOUT / 60)) minutes..."
echo

echo "[4/4] Polling lws /get_address_txs for incoming transaction..."
DEADLINE=$(( $(date +%s) + TIMEOUT ))
ATTEMPT=0
RESP=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  RESP=$(./sndev compose --profile monero exec -T monero-lws curl -sk -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"address\":\"$ADDRESS\",\"view_key\":\"$VIEWKEY\"}" \
    https://127.0.0.1:8443/get_address_txs 2>/dev/null || true)

  TX_HASH=$(echo "$RESP" | grep -o '"hash":"[0-9a-f]*"' | head -1 || true)

  if [ -n "$TX_HASH" ]; then
    echo
    echo "================================================================"
    echo "SUCCESS: transaction observed by monero-lws after ${ATTEMPT} poll(s)."
    echo "================================================================"
    echo "$RESP"
    echo
    echo "Phase 1 exit gate PASSED."
    exit 0
  fi

  HEIGHT=$(echo "$RESP" | grep -o '"blockchain_height":[0-9]*' || echo "blockchain_height=?")
  echo "  poll #${ATTEMPT}: no tx yet ($HEIGHT) - retrying in ${POLL_INTERVAL}s..."
  sleep "$POLL_INTERVAL"
done

echo
echo "================================================================"
echo "FAIL: no transaction observed within $((TIMEOUT / 60)) minutes."
echo "================================================================"
echo "Last response from /get_address_txs:"
echo "$RESP"
echo
echo "Troubleshooting:"
echo "  1. Verify the faucet sent the XMR: check $ADDRESS on https://stagenet.xmrchain.net/"
echo "  2. Verify monerod is synced:  ./sndev monero status"
echo "  3. Verify the account is active: ./sndev monero accounts"
echo "  4. If monerod was syncing when you sent, lws may not have scanned that height yet -"
echo "     wait for sync to complete, then: ./sndev monero rescan $ADDRESS 0"
exit 1
