#!/bin/sh
set -e

NETWORK="${MONERO_NETWORK:-stagenet}"

case "$NETWORK" in
  mainnet)
    LWS_NETWORK=main
    DEFAULT_ZMQ_RPC_PORT=18082
    DEFAULT_ZMQ_PUB_PORT=18083
    ;;
  stagenet)
    LWS_NETWORK=stage
    DEFAULT_ZMQ_RPC_PORT=38082
    DEFAULT_ZMQ_PUB_PORT=38083
    ;;
  testnet)
    LWS_NETWORK=test
    DEFAULT_ZMQ_RPC_PORT=28082
    DEFAULT_ZMQ_PUB_PORT=28083
    ;;
  *)
    echo "entrypoint: unknown MONERO_NETWORK='$NETWORK' (expected mainnet|stagenet|testnet)" >&2
    exit 1
    ;;
esac

ZMQ_RPC_PORT="${MONEROD_ZMQ_RPC_PORT:-$DEFAULT_ZMQ_RPC_PORT}"
ZMQ_PUB_PORT="${MONEROD_ZMQ_PUB_PORT:-$DEFAULT_ZMQ_PUB_PORT}"
DAEMON_URL="${MONEROD_ZMQ_RPC_URL:-tcp://monerod:${ZMQ_RPC_PORT}}"
SUB_URL="${MONEROD_ZMQ_PUB_URL:-tcp://monerod:${ZMQ_PUB_PORT}}"

if [ ! -f /keys/lws.key ] || [ ! -f /keys/lws.crt ]; then
  echo "[monero-lws entrypoint] generating self-signed TLS certificate..."
  /usr/local/bin/gen-keys.sh /keys
else
  echo "[monero-lws entrypoint] existing TLS certificate found, reusing."
fi

echo "[monero-lws entrypoint] network=${LWS_NETWORK} daemon=${DAEMON_URL} sub=${SUB_URL}"

exec monero-lws-daemon \
  --network="$LWS_NETWORK" \
  --daemon="$DAEMON_URL" \
  --sub="$SUB_URL" \
  "$@"
