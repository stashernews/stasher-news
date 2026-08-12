#!/usr/bin/env sh
# Ship archived WAL segments + a periodic base backup offsite so PITR is
# possible even if the VPS disk is lost. Pair with DB_ARCHIVE_MODE=on (set in
# .env.local) which makes Postgres copy each WAL segment into WAL_ARCHIVE_DIR.
#
# Requires: rclone configured with a remote named $RCLONE_REMOTE (e.g. b2, r2, s3).
# Run hourly from cron:
#   0 * * * * /opt/stashernews/scripts/backup-wal-offsite.sh >> /var/log/wal-sync.log 2>&1
set -eu

WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-/var/lib/stashernews/wal-archive}"
RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE must be set, e.g. 'b2:stashernews-wal'}"
BASE_BACKUP_HOURS="${BASE_BACKUP_HOURS:-24}"  # take a fresh base backup daily
POSTGRES_USER="${POSTGRES_USER:-stasher}"

mkdir -p "$WAL_ARCHIVE_DIR"

# Daily base backup (required once before WAL segments are useful for PITR).
# Only stamp the freshness flag on success — on failure we retry next run.
BASE_FLAG="$WAL_ARCHIVE_DIR/.last-base"
needs_base=0
if [ ! -f "$BASE_FLAG" ]; then
  needs_base=1
else
  age_h=$(( ($(date +%s) - $(stat -c %Y "$BASE_FLAG")) / 3600 ))
  [ "$age_h" -ge "$BASE_BACKUP_HOURS" ] && needs_base=1
fi
if [ "$needs_base" -eq 1 ]; then
  echo "$(date -u +%FT%TZ) taking base backup"
  rm -rf "$WAL_ARCHIVE_DIR/base"
  if pg_basebackup -D "$WAL_ARCHIVE_DIR/base" -Ft -z -P -U "$POSTGRES_USER"; then
    date -u +%FT%TZ > "$BASE_FLAG"
  else
    echo "$(date -u +%FT%TZ) WARNING: base backup failed; will retry next run" >&2
  fi
fi

# Ship everything in the archive dir (rclone sync is idempotent on identical content)
rclone sync "$WAL_ARCHIVE_DIR" "$RCLONE_REMOTE" --transfers 4 --checkers 8

echo "$(date -u +%FT%TZ) wal offsite sync complete"
