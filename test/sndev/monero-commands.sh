#!/usr/bin/env bash
# Never implicitly recreate a production compose stack without its overrides.
# Stub Docker on PATH; only explicit `monero up` may start services.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SNDEV="$REPO_ROOT/sndev"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DOCKER_LOG="$TMP/docker.log"
export SNDEV_TEST_DOCKER_LOG="$DOCKER_LOG"

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SNDEV_TEST_DOCKER_LOG"
if [ "$1" != "compose" ]; then
  exit 0
fi
shift
while [ "${1:-}" = "--env-file" ]; do shift 2; done
if [ "${1:-}" = "--profile" ]; then shift 2; fi
sub="${1:-}"
shift || true
case "$sub" in
  ps)
    # compose ps (without -a) lists only running containers
    if [ "${SNDEV_TEST_STACK_UP:-0}" = "1" ]; then
      printf '%s\n' 'stub-container-1' 'stub-container-2'
    fi
    ;;
  exec)
    if [ "${SNDEV_TEST_STACK_UP:-0}" != "1" ]; then
      echo "Error response from daemon: container not running" >&2
      exit 1
    fi
    ;;
  up)
    # drift marker: sndev must never swallow this output
    echo "Recreating monerod..."
    ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/docker"

OUT="$TMP/out"
ERR="$TMP/err"
PASS=0
FAIL=0
RC=0

# run_monero STACK_UP ARGS... - invokes `sndev monero ARGS...`, captures rc
run_monero() {
  local stack_up="$1"
  shift
  : > "$DOCKER_LOG"
  PATH="$TMP/bin:$PATH" SNDEV_TEST_STACK_UP="$stack_up" \
    sh "$SNDEV" monero "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

pass_msg() {
  PASS=$((PASS + 1))
}

fail_msg() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $*"
}

# --- contract 1: no subcommand runs an implicit `up` -----------------------
for sub in status accounts faucet add_account rescan register-rewards-wallet \
           register-bounty-escrow-wallet derive-fee-pool distribute requeue \
           makeup backfill-budget rotate-master-key; do
  case "$sub" in
    faucet)      set -- "tmaddr" ;;
    add_account) set -- "tmaddr" "viewkey" ;;
    rescan)      set -- "tmaddr" "123" ;;
    requeue)     set -- "id1" ;;
    makeup)      set -- "id1" ;;
    *)           set -- ;;
  esac
  run_monero 0 "$sub" "$@"
  if grep -q ' up -d monerod monero-lws' "$DOCKER_LOG"; then
    fail_msg "monero $sub ran an implicit 'up' (stack-safety violation)"
  else
    pass_msg
  fi
done

# --- contract 2: mutating subcommands fail fast when the stack is down -----
for mutation in "add_account tmaddr viewkey" "distribute" "requeue id1"; do
  # shellcheck disable=SC2086
  run_monero 0 $mutation
  if [ "$RC" -ne 0 ] && grep -q 'sndev monero up' "$ERR"; then
    pass_msg
  else
    fail_msg "monero ${mutation%% *} did not fail fast with 'sndev monero up' guidance when the stack is down (rc=$RC)"
  fi
done

# Account listing must explain a down stack without attempting an exec.
run_monero 0 accounts
if [ "$RC" -ne 0 ] && grep -q 'sndev monero up' "$ERR" \
  && ! grep -q ' exec ' "$DOCKER_LOG"; then
  pass_msg
else
  fail_msg "monero accounts must fail with startup guidance before exec when the stack is down (rc=$RC)"
fi

run_monero 1 accounts
if [ "$RC" -eq 0 ] && grep -q ' exec ' "$DOCKER_LOG" \
  && ! grep -q ' up -d monerod monero-lws' "$DOCKER_LOG"; then
  pass_msg
else
  fail_msg "monero accounts with the stack up must list accounts without any 'up' (rc=$RC)"
fi

# --- contract 3: status is read-only diagnostics on a down stack -----------
run_monero 0 status
if [ "$RC" -eq 0 ] && grep -q 'unreachable' "$OUT" \
  && ! grep -q ' up -d monerod monero-lws' "$DOCKER_LOG"; then
  pass_msg
else
  fail_msg "monero status on a down stack must exit 0, report unreachable, and never 'up' (rc=$RC)"
fi

# --- contract 4: the explicit `sndev monero up` is loud --------------------
run_monero 0 up
if [ "$RC" -eq 0 ] \
  && grep -q ' up -d monerod monero-lws' "$DOCKER_LOG" \
  && grep -q 'Recreating monerod' "$OUT"; then
  pass_msg
else
  fail_msg "monero up must invoke compose up and keep its output visible (rc=$RC)"
fi

# --- contract 5: guard passes when the stack is already up -----------------
run_monero 1 add_account "tmaddr" "viewkey"
if [ "$RC" -eq 0 ] \
  && grep -q ' exec ' "$DOCKER_LOG" \
  && ! grep -q ' up -d monerod monero-lws' "$DOCKER_LOG"; then
  pass_msg
else
  fail_msg "monero add_account with the stack up must proceed via exec, without any 'up' (rc=$RC)"
fi

echo
echo "sndev monero stack-safety: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
