#!/usr/bin/env bash
#
# backup-master-key.sh — gpg-encrypt VIEWKEY_MASTER_KEY to BACKUP_PUBLIC_KEY and
# write the blob to MASTERKEY_BACKUP_DIR (Phase 6 Task E2).
#
# VIEWKEY_MASTER_KEY is the AES-256-GCM envelope key for every MoneroViewKey row.
# Losing it is unrecoverable data loss, so the blob MUST be stored SEPARATELY from
# the DB backups (different dir / bucket / operator). The script refuses to write
# into BACKUP_DIR to enforce that.
#
# Run on first key provisioning AND on every master-key rotation (Task C2): a
# versioned registry means each retired key must also be escrowed, not just the
# current one, so old encrypted DB backups stay restorable.
#
# Runs inside the worker container, which has gpg + the env loaded. Output:
# $MASTERKEY_BACKUP_DIR/masterkey-v<version>-<utc-timestamp>.b64.gpg
# Prints the final path on stdout (last line).
set -euo pipefail

: "${VIEWKEY_MASTER_KEY:?VIEWKEY_MASTER_KEY is required}"
: "${BACKUP_PUBLIC_KEY:?BACKUP_PUBLIC_KEY is required}"
: "${MASTERKEY_BACKUP_DIR:?MASTERKEY_BACKUP_DIR is required (must differ from BACKUP_DIR)}"
: "${VIEWKEY_MASTER_KEY_CURRENT_VERSION:=1}"

mkdir -p "$MASTERKEY_BACKUP_DIR"

# Refuse to co-locate with the DB backups — separate failure domains is the
# whole point of this script. realpath -m normalizes so trailing-slash / relative
# differences don't defeat the check (GNU coreutils; this runs in the worker).
mk_norm="$(realpath -m "$MASTERKEY_BACKUP_DIR")"
if [ -n "${BACKUP_DIR:-}" ]; then
  bk_norm="$(realpath -m "$BACKUP_DIR")"
  case "$mk_norm/" in
    "$bk_norm"|"$bk_norm"/*)
      echo "MASTERKEY_BACKUP_DIR ($MASTERKEY_BACKUP_DIR) must differ from BACKUP_DIR ($BACKUP_DIR)" >&2
      exit 1
      ;;
  esac
  # Reverse direction: BACKUP_DIR must not live inside MASTERKEY_BACKUP_DIR.
  case "$bk_norm/" in
    "$mk_norm"|"$mk_norm"/*)
      echo "MASTERKEY_BACKUP_DIR ($MASTERKEY_BACKUP_DIR) must not be a parent of BACKUP_DIR ($BACKUP_DIR)" >&2
      exit 1
      ;;
  esac
fi

# Optionally import the recipient's public key from a file before encrypting.
if [ -n "${BACKUP_PUBLIC_KEY_FILE:-}" ]; then
  gpg --batch --import "$BACKUP_PUBLIC_KEY_FILE"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$MASTERKEY_BACKUP_DIR/masterkey-v${VIEWKEY_MASTER_KEY_CURRENT_VERSION}-${timestamp}.b64.gpg"
tmp="${file}.tmp"

# Remove the partial .tmp if gpg aborts (bad recipient, missing key, disk full).
# No-op on success — by exit time the .tmp has been renamed away.
trap 'rm -f "$tmp"' EXIT

# The master key value is a short base64 string; encrypt it verbatim so the
# restore path is: gpg --decrypt -> paste the base64 back into .env.local.
printf '%s' "$VIEWKEY_MASTER_KEY" \
  | gpg --trust-model always --batch --yes \
        --recipient "$BACKUP_PUBLIC_KEY" \
        --encrypt \
        --output "$tmp"

mv "$tmp" "$file"
printf '%s\n' "$file"
