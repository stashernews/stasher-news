#!/usr/bin/env bash
set -euo pipefail

NETWORK="${MONERO_NETWORK:-stagenet}"

case "$NETWORK" in
  mainnet)
    NETWORK_FLAG=()
    DEFAULT_RPC_PORT=18081
    DEFAULT_ZMQ_RPC_PORT=18082
    DEFAULT_ZMQ_PUB_PORT=18083
    SEED_PEERS=(
      xmr-node.cakewallet.com:18080
      nodes.monerodev.org:18080
      node.community.rino.io:18080
      node.sethforprivacy.com:18080
      monero.stackwallet.com:18080
      node.moneroworld.com:18080
      nodes.hashvault.pro:18080
      monero.heitechsoft.com:18080
    )
    ;;
  stagenet)
    NETWORK_FLAG=(--stagenet)
    DEFAULT_RPC_PORT=38081
    DEFAULT_ZMQ_RPC_PORT=38082
    DEFAULT_ZMQ_PUB_PORT=38083
    SEED_PEERS=(
      node.sethforprivacy.com:38080
      stagenet.xmr-tw.org:38080
      xmr-node.cakewallet.com:38080
    )
    ;;
  testnet)
    NETWORK_FLAG=(--testnet)
    DEFAULT_RPC_PORT=28081
    DEFAULT_ZMQ_RPC_PORT=28082
    DEFAULT_ZMQ_PUB_PORT=28083
    SEED_PEERS=(
      node.sethforprivacy.com:28080
      testnet.xmr-tw.org:28080
    )
    ;;
  *)
    echo "entrypoint: unknown MONERO_NETWORK='$NETWORK' (expected mainnet|stagenet|testnet)" >&2
    exit 1
    ;;
esac

RPC_PORT="${MONEROD_RPC_PORT:-$DEFAULT_RPC_PORT}"
ZMQ_RPC_PORT="${MONEROD_ZMQ_RPC_PORT:-$DEFAULT_ZMQ_RPC_PORT}"
ZMQ_PUB_PORT="${MONEROD_ZMQ_PUB_PORT:-$DEFAULT_ZMQ_PUB_PORT}"

ARGS=("${NETWORK_FLAG[@]}")
ARGS+=(
  --rpc-bind-port="$RPC_PORT"
  --zmq-rpc-bind-port="$ZMQ_RPC_PORT"
  --zmq-pub=tcp://0.0.0.0:"$ZMQ_PUB_PORT"
)

for peer in "${SEED_PEERS[@]}"; do
  ARGS+=(--add-peer="$peer")
done

exec /opt/monero/monerod "${ARGS[@]}" "$@"
