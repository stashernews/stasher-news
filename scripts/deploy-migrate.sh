#!/usr/bin/env bash
# Safe database migration: snapshot -> migrate -> verify.
# Run this INSTEAD of bare `prisma migrate deploy` on the VPS. It takes a
# pg_dump snapshot immediately before migrating so a destructive or failed
# migration can be rolled back by restoring the snapshot.
#
# Prisma has no down-migrations; rollback = restore this snapshot (forward-only
# policy — see docs/runbooks/migrations.md).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/stashernews}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="${BACKUP_DIR}/pre-migrate-${TS}.sql.gz"

mkdir -p "$BACKUP_DIR"
echo "==> taking pre-migration snapshot: $SNAPSHOT"
pg_dump --no-owner --clean --if-exists "$DATABASE_URL" | gzip > "$SNAPSHOT"
echo "==> snapshot written ($(du -h "$SNAPSHOT" | cut -f1))"

echo "==> running prisma migrate deploy"
if ! npx prisma migrate deploy; then
  echo "!!! migration failed. DB may be in a partially-migrated state." >&2
  echo "!!! to roll back, restore the snapshot with ON_ERROR_STOP so a partial" >&2
  echo "!!! restore aborts instead of leaving a half-restored DB:" >&2
  echo "!!!   gunzip -c $SNAPSHOT | psql -v ON_ERROR_STOP=1 \"$DATABASE_URL\"" >&2
  exit 1
fi

echo "==> migration complete. snapshot retained at $SNAPSHOT"
