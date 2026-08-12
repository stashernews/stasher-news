#!/usr/bin/env sh
# Decrypt SOPS-encrypted secrets at boot and exec the real command with them
# in the environment. Used as the systemd ExecStart / docker entrypoint.
#
# Uses `sops exec-env` (not eval) so secret values with shell metacharacters are
# handled safely. The age private key has NO passphrase so the worker/app can
# boot autonomously; protect the key with file perms + full-disk encryption.
set -eu

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/etc/stashernews/keys/age.agekey}"
SECRETS_FILE="${SECRETS_FILE:-/etc/stashernews/secrets.env}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "load-secrets: missing $SECRETS_FILE" >&2
  exit 1
fi

# sops exec-env <file> <command...> decrypts the dotenv file and runs the command
# with the decrypted vars injected into its environment.
exec sops exec-env "$SECRETS_FILE" "$@"
