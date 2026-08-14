#!/usr/bin/env bash

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on EB host — install the postgresql client (dnf install postgresql15 or .ebextensions packages) before enabling snapshot migrations" >&2
  exit 1
fi

echo safe migrate \(snapshot first\)
bash scripts/deploy-migrate.sh || exit 1

echo build with npm
sudo -E -u webapp npm run build