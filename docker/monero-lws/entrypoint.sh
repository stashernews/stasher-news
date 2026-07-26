#!/bin/sh
set -e

if [ ! -f /keys/lws.key ] || [ ! -f /keys/lws.crt ]; then
  echo "[monero-lws entrypoint] generating self-signed TLS certificate..."
  /usr/local/bin/gen-keys.sh /keys
else
  echo "[monero-lws entrypoint] existing TLS certificate found, reusing."
fi

exec monero-lws-daemon "$@"
