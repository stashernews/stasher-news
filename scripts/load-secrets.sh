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

# The command is mandatory. systemd ExecStart always provides one, but a
# docker-compose override that sets `entrypoint:` WITHOUT a `command:` makes
# compose pass no args (cmd=null) and the container silently exits 0. Fail
# loudly instead of booting nothing.
if [ "$#" -eq 0 ]; then
  echo "load-secrets: no command given — check the compose override: put the loader as the FIRST element of command:, not in entrypoint:" >&2
  exit 1
fi

# sops exec-env <file> <command> decrypts the dotenv file and runs the command
# with the decrypted vars injected into its environment. The command must be a
# SINGLE positional argument: sops enforces exactly 2 positional args
# (cmd/sops/main.go exec-env action) and otherwise fails with the misleading
# "error: missing file to decrypt" — before even reading the file. Forwarding
# "$@" breaks on any multi-word command (`npm start` = 3 args). Join with "$*"
# so the whole command line is one argument, which exec-env runs via sh -c.
exec sops exec-env "$SECRETS_FILE" "$*"
