#!/usr/bin/env bash
#
# test-restore.sh — DR restore-validation test (Phase 6 Task E5).
#
# Proves the disaster-recovery RESTORE path end-to-end against a live dev-DB
# snapshot, without touching the dev DB itself:
#   1. pg_dump the stackernews dev DB,
#   2. restore the dump into a throwaway DB (stackernews_restore_test),
#   3. re-supply VIEWKEY_MASTER_KEY — read from the running `app` container env,
#      i.e. the same escrowed key an operator pastes back after a restore,
#   4. assert decryptViewKey (api/monero/viewkey.js) succeeds on EVERY
#      MoneroViewKey row in the restored DB.
#
# This complements the failure-path unit test
# (test/api/monero/viewkey.test.js:111-115): that test proves losing the master
# key bricks decryption; this script proves the inverse — restore DB + re-supply
# key => every envelope decrypts. Together they close the key-escrow loop opened
# by scripts/backup-db.sh and scripts/backup-master-key.sh.
#
# Safe by construction: the dev DB is only read (pg_dump); the throwaway DB is
# created, validated, and dropped on success, failure, or interruption. Run
# before any mainnet cutover (Workstream E exit gate) and after any change to the
# backup format or master-key escrow.
#
# Prerequisites: the sndev stack must be up (db + app containers running, the app
# container holding VIEWKEY_MASTER_KEY).
#
# Usage:
#   ./scripts/test-restore.sh
#
# Optional overrides:
#   SOURCE_DB / RESTORE_DB / DB_CONTAINER / APP_CONTAINER
#   KEEP_RESTORE_DB=1  leave the throwaway DB in place for manual inspection
#
#   Weekly restore drill (root, VPS — proves the restore path stays green):
#     0 5 * * 0 /opt/stashernews/scripts/test-restore.sh >> /var/log/test-restore.log 2>&1
#   Failures POST to ALERT_WEBHOOK_URL when set (same shape as lib/alert.js);
#   on dev machines (no ALERT_WEBHOOK_URL) it degrades to the stderr message.
set -euo pipefail

SOURCE_DB="${SOURCE_DB:-stackernews}"
RESTORE_DB="${RESTORE_DB:-stackernews_restore_test}"
DB_CONTAINER="${DB_CONTAINER:-db}"
APP_CONTAINER="${APP_CONTAINER:-app}"

# Alert wiring: cron runs as root with an empty environment; ALERT_WEBHOOK_URL
# lives SOPS-encrypted at the same path the app boots from. Best-effort.
SECRETS_FILE="${SECRETS_FILE:-/etc/stashernews/secrets.env}"
if [ -z "${ALERT_WEBHOOK_URL:-}" ] && [ -f "$SECRETS_FILE" ] && command -v sops >/dev/null 2>&1; then
  SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/etc/stashernews/keys/age.agekey}"
  export SOPS_AGE_KEY_FILE
  ALERT_WEBHOOK_URL="$(sops -d --extract '["ALERT_WEBHOOK_URL"]' "$SECRETS_FILE" 2>/dev/null || true)"
fi

drop_restore_db() {
  # A restored psql may briefly hold a connection; force-disconnect before DROP so
  # cleanup is reliable even if the EXIT trap fires mid-restore.
  docker exec -i "$DB_CONTAINER" psql -U sn -d postgres -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$RESTORE_DB';" > /dev/null 2>&1 || true
  docker exec -i "$DB_CONTAINER" psql -U sn -d postgres -tAc \
    "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" > /dev/null 2>&1 || true
}

cleanup() {
  if [ -n "${KEEP_RESTORE_DB:-}" ]; then
    echo "test-restore: KEEP_RESTORE_DB set — leaving '$RESTORE_DB' for inspection" >&2
  else
    drop_restore_db
  fi
}
trap cleanup EXIT

notify () {
  local level=$1 title=$2 body=$3
  echo "test-restore: $title — $body" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -sf -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[${level}] ${title}\n${body}\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}

echo "test-restore: resetting throwaway DB '$RESTORE_DB'"
drop_restore_db
docker exec -i "$DB_CONTAINER" psql -U sn -d postgres -tAc \
  "CREATE DATABASE \"$RESTORE_DB\";" > /dev/null

echo "test-restore: pg_dump '$SOURCE_DB' -> restore into '$RESTORE_DB'"
restore_log="$(mktemp)"
if ! docker exec "$DB_CONTAINER" pg_dump -U sn "$SOURCE_DB" 2>"$restore_log" \
     | docker exec -i "$DB_CONTAINER" psql -U sn -d "$RESTORE_DB" -q -v ON_ERROR_STOP=1 >>"$restore_log" 2>&1; then
  notify CRITICAL "restore drill FAILED" "could not restore dump into ${RESTORE_DB} (see cron log)"
  echo "test-restore: FAIL — could not restore dump into '$RESTORE_DB'" >&2
  cat "$restore_log" >&2
  rm -f "$restore_log"
  exit 1
fi
rm -f "$restore_log"

row_count="$(docker exec "$DB_CONTAINER" psql -U sn -d "$RESTORE_DB" -tAc \
  "SELECT count(*) FROM \"MoneroViewKey\";")"
echo "test-restore: restored DB has $row_count MoneroViewKey row(s)"

echo "test-restore: validating decryptViewKey on every row (app container, real VIEWKEY_MASTER_KEY)..."
# COPY ... TO STDOUT (not SELECT) so long hex rows are never line-wrapped by
# psql, which would corrupt the pipe-delimited framing consumed by the checker.
# Hex (not base64) is used for the bytea fields: postgres encode(...,'base64')
# inserts a real newline every 76 chars which COPY then escapes as backslash-n,
# and Node's base64 decoder would mis-read the stray 'n' — corrupting the
# envelope and tripping a false GCM auth failure. Hex has no such wrapping.
if docker exec "$DB_CONTAINER" psql -U sn -d "$RESTORE_DB" -tAc \
     "COPY (SELECT id, \"dekVersion\", encode(ciphertext,'hex'), encode(iv,'hex'), encode(tag,'hex'), encode(\"wrappedDek\",'hex') FROM \"MoneroViewKey\" ORDER BY id) TO STDOUT WITH (DELIMITER '|')" \
     | docker exec -i -w /app "$APP_CONTAINER" npx tsx --tsconfig jsconfig.json scripts/test-restore-check.js; then
  echo "test-restore: PASS — DB restored into '$RESTORE_DB' and every MoneroViewKey row decrypts under VIEWKEY_MASTER_KEY"
else
  rc=$?
  notify CRITICAL "restore drill FAILED" "decryptViewKey did not succeed on every row in ${RESTORE_DB}"
  echo "test-restore: FAIL — decryptViewKey did not succeed on every row (see restore-check output above)" >&2
  exit "$rc"
fi
