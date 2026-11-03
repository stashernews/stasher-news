#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
compose=(docker compose --env-file .env.development)
if [[ -f .env.local ]]; then compose+=(--env-file .env.local); fi

ok=1
binding=$("${compose[@]}" port caddy 9443 2>/dev/null || true)
if [[ "$binding" != '127.0.0.1:9443' ]]; then
  echo 'admin edge: listener is not bound exclusively to the expected loopback address' >&2
  ok=0
fi

check_status() {
  local expected=$1 url=$2 status
  shift 2
  status=$(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{http_code}' "$@" "$url" || true)
  if [[ "$status" != "$expected" ]]; then
    echo "admin edge: $url: expected $expected, received $status" >&2
    ok=0
  fi
}

for path in /admin /api/admin/graphql; do
  check_status 404 "https://stasher.news${path}"
  check_status 404 "https://stasher.news${path}" --header 'X-Admin-Gate: forged-edge-check-not-a-real-secret'
done
check_status 200 'http://127.0.0.1:9443/admin'
# A foreign Host (DNS rebinding through the tunnel) must not reach the app.
check_status 404 'http://127.0.0.1:9443/admin' --header 'Host: rebind.invalid'

# Record failure as well as success. The recorder only updates edge freshness.
if ! docker exec -i -w /app -e "ADMIN_EDGE_OK=$ok" -e TSX_TSCONFIG_PATH=jsconfig.json app npx tsx scripts/admin-edge-record.js; then
  echo 'admin edge: could not persist check result' >&2
  exit 1
fi
if [[ "$ok" != 1 ]]; then
  echo 'admin edge check failed' >&2
  exit 1
fi
echo 'admin edge check passed'
