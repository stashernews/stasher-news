#!/usr/bin/env bash
set -euo pipefail

NETWORK="${MONERO_NETWORK:-stagenet}"

# Seed peers passed to monerod as --add-peer. An unresolvable seed host is
# FATAL to daemon startup: p2p init fails ("Failed to initialize p2p server."
# on the console; the real cause — "Failed to resolve host name" — is only in
# bitmonero.log under the data dir) and the compose restart policy crash-loops.
# DNS-verify EVERY hostname here before touching these lists — monerod also
# does its own DNSSEC-validating resolution, stricter than getent. All hosts
# in all three lists verified resolving: 2026-09-02.
case "$NETWORK" in
  mainnet)
    NETWORK_FLAG=()
    DEFAULT_RPC_PORT=18081
    DEFAULT_ZMQ_RPC_PORT=18082
    DEFAULT_ZMQ_PUB_PORT=18083
    SEED_PEERS=(
      xmr-node.cakewallet.com:18080
      node.sethforprivacy.com:18080
      monero.stackwallet.com:18080
      nodes.hashvault.pro:18080
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

# Pre-flight: a seed that does not resolve on THIS network is dropped with a
# warning instead of being passed through — an unresolvable --add-peer is
# fatal to monerod p2p init and crash-loops the container. getent is stricter
# than nothing but looser than monerod's own DNSSEC resolution; it catches the
# NXDOMAIN/dead-host case, which is the one that bricks startup. If every
# seed is dropped, boot continues on monerod's built-in peer discovery.
filtered_seeds=()
for peer in ${SEED_PEERS[@]+"${SEED_PEERS[@]}"}; do
  seed_host="${peer%%:*}"
  if getent hosts "$seed_host" >/dev/null 2>&1; then
    filtered_seeds+=("$peer")
  else
    echo "entrypoint: WARNING: seed peer '$seed_host' does not resolve — dropping it (an unresolvable --add-peer is fatal to startup)" >&2
  fi
done
if [ "${#SEED_PEERS[@]}" -gt 0 ] && [ "${#filtered_seeds[@]}" -eq 0 ]; then
  echo "entrypoint: WARNING: every configured seed peer failed to resolve; booting on monerod's built-in peer discovery alone" >&2
fi
SEED_PEERS=("${filtered_seeds[@]+"${filtered_seeds[@]}"}")

RPC_PORT="${MONEROD_RPC_PORT:-$DEFAULT_RPC_PORT}"
ZMQ_RPC_PORT="${MONEROD_ZMQ_RPC_PORT:-$DEFAULT_ZMQ_RPC_PORT}"
ZMQ_PUB_PORT="${MONEROD_ZMQ_PUB_PORT:-$DEFAULT_ZMQ_PUB_PORT}"

ARGS=(${NETWORK_FLAG[@]+"${NETWORK_FLAG[@]}"})
ARGS+=(
  --rpc-bind-port="$RPC_PORT"
  --zmq-rpc-bind-port="$ZMQ_RPC_PORT"
  --zmq-pub=tcp://0.0.0.0:"$ZMQ_PUB_PORT"
)

for peer in "${SEED_PEERS[@]}"; do
  ARGS+=(--add-peer="$peer")
done

exec /opt/monero/monerod "${ARGS[@]}" "$@"
