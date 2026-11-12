#!/usr/bin/env bash
# Validate a mkp224o key find, stage it into the onion_tordata volume, and
# PROVE it by making tor re-derive the hostname from the secret key alone.
# Usage: scripts/onion-import-key.sh .onion-keys/<host>.onion
# See docs/onion-mirror.md. Refuses a non-empty volume hs dir (review-focus:
# never overwrite an existing identity by accident).
set -euo pipefail

VOLUME=stashernews_onion_tordata
IMAGE=stashernews-onion-tor
# digest-pinned base, same digest the onion images pin
HELPER_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
LABEL="[onion-import-key]"

[ $# -eq 1 ] || { echo "$LABEL usage: $0 .onion-keys/<host>.onion" >&2; exit 2; }
src=$1
base=$(basename "$src")
[[ $base =~ ^[a-z2-7]{56}\.onion$ ]] || { echo "$LABEL not an onion key dir: $base" >&2; exit 2; }
for f in hostname hs_ed25519_secret_key hs_ed25519_public_key; do
  [ -f "$src/$f" ] || { echo "$LABEL missing $f in $src" >&2; exit 2; }
done
# docker -v bind sources cannot be relative and the documented invocation is
# relative (a staging cwd like ~/onion-key-staging) — resolve before any
# docker use; the file checks above prove the directory exists.
src=$(cd "$src" && pwd -P)
grep -qx "$base" "$src/hostname" || { echo "$LABEL hostname file disagrees with dir name" >&2; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "$LABEL build $IMAGE first (docker/onion/)" >&2; exit 2; }

# 1) verify: tor re-derives the address AND public key from the SECRET key alone
work=$(mktemp -d "${TMPDIR:-/tmp}/onion-verify.XXXXXX")
trap 'docker rm -f onion-verify >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
cp "$src/hs_ed25519_secret_key" "$work/hs_ed25519_secret_key"
chmod 700 "$work"; chmod 600 "$work/hs_ed25519_secret_key"
# host user so the derived hostname lands host-owned; CLI LINELIST options
# replace the file's HiddenService* lines, so the port target is re-specified
docker run --rm -d --name onion-verify \
  --user "$(id -u):$(id -g)" \
  -v "$work:/tordata/hs" --tmpfs /tordata/data:uid="$(id -u)",gid="$(id -g)" \
  "$IMAGE" tor -f /etc/tor/torrc --SocksPort 0 --HiddenServiceDir /tordata/hs --HiddenServicePort '80 127.0.0.1:9' >/dev/null
for _ in $(seq 1 20); do
  [ -f "$work/hostname" ] && [ -f "$work/hs_ed25519_public_key" ] && break
  sleep 1
done
[ -f "$work/hostname" ] && [ -f "$work/hs_ed25519_public_key" ] \
  || { echo "$LABEL tor never derived the hostname/public key — see container logs" >&2; exit 1; }
derived=$(cat "$work/hostname")
[ "$derived" = "$base" ] || { echo "$LABEL tor derived $derived, expected $base — key mismatch" >&2; exit 1; }
cmp -s "$work/hs_ed25519_public_key" "$src/hs_ed25519_public_key" \
  || { echo "$LABEL tor-derived public key does not match $src/hs_ed25519_public_key — stale/corrupt public key, refusing to stage" >&2; exit 1; }
echo "$LABEL verified: secret key derives $base and matches the staged public key"

# 2) stage into the volume; refuse a non-empty hs dir
hs_count=$(docker run --rm -v "$VOLUME:/tordata" "$HELPER_IMAGE" \
  sh -c 'ls -A /tordata/hs 2>/dev/null | wc -l' 2>/dev/null || echo 0)
[ "$hs_count" = "0" ] || { echo "$LABEL volume hs dir not empty — refusing; clear it deliberately (docs/onion-mirror.md)" >&2; exit 1; }
docker run --rm \
  -v "$VOLUME:/tordata" -v "$src:/src:ro" "$HELPER_IMAGE" \
  sh -c 'mkdir -p /tordata/hs /tordata/data && cp /src/hs_ed25519_secret_key /src/hs_ed25519_public_key /src/hostname /tordata/hs/ && chmod 700 /tordata/hs && chmod 600 /tordata/hs/* && chown -R 1000:1000 /tordata'
echo "$LABEL staged into volume $VOLUME (perms 0700/0600, uid 1000)"
echo "$LABEL next: attach the overlay and start (docs/onion-mirror.md). Address: $base"
