#!/usr/bin/env bash
#
# backup-db.sh — dump + encrypt the stackernews DB (Phase 6 Task E1).
#
# pg_dump of POSTGRES_DB piped through gpg asymmetric encryption to the
# BACKUP_PUBLIC_KEY recipient, written to BACKUP_DIR/<db>-<utc-timestamp>.sql.gpg.
# The dump is streamed to a .tmp file then atomically renamed so a partial write
# is never mistaken for a complete backup by the pruner. Prints the final path
# on stdout (last line) for the caller (worker/dbBackup.js) to pick up for S3
# upload. Designed to run inside the worker container, which has the matched
# postgresql-client + gpg and network reach to the db.
set -euo pipefail

: "${POSTGRES_HOST:=db}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:=stackernews}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_PUBLIC_KEY:?BACKUP_PUBLIC_KEY is required}"

mkdir -p "$BACKUP_DIR"

# Optionally import the recipient's public key from a file before encrypting.
if [ -n "${BACKUP_PUBLIC_KEY_FILE:-}" ]; then
  gpg --batch --import "$BACKUP_PUBLIC_KEY_FILE"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/${POSTGRES_DB}-${timestamp}.sql.gpg"
tmp="${file}.tmp"

# Clean up the partial .tmp if pg_dump/gpg aborts mid-stream (bad creds, disk
# full, missing key). The pruner only matches /\.sql\.gpg$/, so without this
# trap a stranded .tmp would accumulate on every failed run and fill the volume.
# No-op on success — by exit time the .tmp has been renamed away.
trap 'rm -f "$tmp"' EXIT

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host "$POSTGRES_HOST" \
  --port "$POSTGRES_PORT" \
  --username "$POSTGRES_USER" \
  "$POSTGRES_DB" \
  | gpg --trust-model always --batch --yes \
        --recipient "$BACKUP_PUBLIC_KEY" \
        --encrypt \
        --output "$tmp"

mv "$tmp" "$file"
printf '%s\n' "$file"
