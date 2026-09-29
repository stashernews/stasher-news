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

# Admin auth is ON by default (secure/prod posture). Dev opts out by setting
# LWS_ADMIN_AUTH_ENABLED=false so local flows need no admin key; prod MUST leave
# this unset (or =true) and set MONERO_LWS_ADMIN_AUTH in .env.local.
case "${LWS_ADMIN_AUTH_ENABLED}" in
  false|0|no)
    set -- --disable-admin-auth "$@"
    ADMIN_AUTH_STATE=disabled
    ;;
  *)
    ADMIN_AUTH_STATE=enabled
    ;;
esac

echo "[monero-lws entrypoint] network=${LWS_NETWORK} daemon=${DAEMON_URL} sub=${SUB_URL} admin-auth=${ADMIN_AUTH_STATE}"

exec monero-lws-daemon \
  --network="$LWS_NETWORK" \
  --daemon="$DAEMON_URL" \
  --sub="$SUB_URL" \
  "$@"
