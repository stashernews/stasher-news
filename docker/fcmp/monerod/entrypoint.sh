#!/usr/bin/env bash
set -euo pipefail

NETWORK="${MONERO_NETWORK:-stagenet}"

# FCMP stressnet variant: NO hardcoded seed peers. The stressnet fork ships its
# own built-in stressnet seed list; vanilla-testnet --add-peer entries would
# point at the pre-fork chain after the Oct 5 fork. Manual peers come in via
# FCMP_ADD_PEERS (below), DNS pre-flight-filtered — an unresolvable --add-peer
# is fatal to monerod p2p init ("Failed to initialize p2p server") and the
# compose restart policy crash-loops.
case "$NETWORK" in
  mainnet)
    NETWORK_FLAG=()
    DEFAULT_RPC_PORT=18081
    DEFAULT_ZMQ_RPC_PORT=18082
    DEFAULT_ZMQ_PUB_PORT=18083
    ;;
  stagenet)
    NETWORK_FLAG=(--stagenet)
    DEFAULT_RPC_PORT=38081
    DEFAULT_ZMQ_RPC_PORT=38082
    DEFAULT_ZMQ_PUB_PORT=38083
    ;;
  testnet)
    NETWORK_FLAG=(--testnet)
    DEFAULT_RPC_PORT=28081
    DEFAULT_ZMQ_RPC_PORT=28082
    DEFAULT_ZMQ_PUB_PORT=28083
    ;;
  *)
    echo "entrypoint: unknown MONERO_NETWORK='$NETWORK' (expected mainnet|stagenet|testnet)" >&2
    exit 1
    ;;
esac

RPC_PORT="${MONEROD_RPC_PORT:-$DEFAULT_RPC_PORT}"
ZMQ_RPC_PORT="${MONEROD_ZMQ_RPC_PORT:-$DEFAULT_ZMQ_RPC_PORT}"
ZMQ_PUB_PORT="${MONEROD_ZMQ_PUB_PORT:-$DEFAULT_ZMQ_PUB_PORT}"

ARGS=(${NETWORK_FLAG[@]+"${NETWORK_FLAG[@]}"})
ARGS+=(
  --rpc-bind-port="$RPC_PORT"
  --zmq-rpc-bind-port="$ZMQ_RPC_PORT"
  --zmq-pub=tcp://0.0.0.0:"$ZMQ_PUB_PORT"
)

# Optional manual stressnet peers (space-separated host:port), e.g. from the
# #monero-stressnet:monero.social matrix room. Each is DNS-verified before
# being passed — an unresolvable --add-peer is fatal to startup.
for peer in ${FCMP_ADD_PEERS:-}; do
  seed_host="${peer%%:*}"
  if getent hosts "$seed_host" >/dev/null 2>&1; then
    ARGS+=(--add-peer="$peer")
  else
    echo "entrypoint: WARNING: FCMP_ADD_PEERS entry '$peer' does not resolve — dropping it" >&2
  fi
done

exec /opt/monero/monerod "${ARGS[@]}" "$@"
