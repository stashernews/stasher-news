// Paused-writer payment-proof rotation CLI (Finding #1, Task 8).
//
//   npx tsx --tsconfig jsconfig.json scripts/rotate-payment-proofs.js            # --check (default)
//   npx tsx --tsconfig jsconfig.json scripts/rotate-payment-proofs.js --check
//   npx tsx --tsconfig jsconfig.json scripts/rotate-payment-proofs.js \
//     --rotate --target-version 2 --writers-paused --confirm-version 2
//
// Modes:
//   --check (default)  read-only inventory: required/missing key versions,
//                      row issues (fixed codes + ids), safe counts.
//   --rotate           re-seal every rotatable proof under the ALREADY
//                      provisioned target version. Requires ALL FOUR of
//                      --rotate, --target-version <positive-int>,
//                      --writers-paused and --confirm-version <same-int>.
//                      Mismatched confirmations refuse. The writers pause is a
//                      caller-asserted operational precondition (stop app/worker
//                      sends and cron sends first); the script cannot verify it.
//
// NEVER passes, accepts or prints key material: there is no key argument, the
// registry is read from the loader-exported env, and nothing is ever generated
// to stdout. Provisioning a new version is an operator edit of the SOPS env
// (see docs/ops/rewards-payment-proofs.md) — not this script's job. Output is
// fixed labels, counts, version numbers, proof/journal ids and fixed issue
// codes only. Exit codes: 0 clean, 1 usage/config refusal, 2 completed with
// reported issues/conflicts, 3 unexpected failure (fixed generic label; raw
// driver text is never printed).
//
// Run inside a container that has the env + DB reachable (the same way
// scripts/rotate-master-key.js runs). This script NEVER provisions keys and
// NEVER relays or resends anything.
import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'
import { createPaymentProofKeyProvider } from '../api/monero/paymentProofKeys'
import {
  checkPaymentProofInventory,
  rotatePaymentProofs
} from '../api/monero/paymentProofLifecycle'

const USAGE = [
  'usage: rotate-payment-proofs.js [--check]',
  '       rotate-payment-proofs.js --rotate --target-version <positive-int> --writers-paused --confirm-version <same-int>'
].join('\n')

const FIXED_CODE = /^[A-Z][A-Z0-9_]+$/
const CANONICAL_POSITIVE = /^[1-9][0-9]*$/

const EXIT_OK = 0
const EXIT_USAGE = 1
const EXIT_ISSUES = 2
const EXIT_FAILED = 3
const FAILED_LABEL = 'PROOF_ROTATION_CLI_FAILED'

// Strict flag parser: no key argument exists; unknown, duplicate or mutually
// contradictory flags are refusals.
function parseArgs (argv) {
  let mode = null
  let targetVersion = null
  let writersPaused = false
  let confirmVersion = null
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = nextValue(argv, i)
    switch (flag) {
      case '--check':
      case '--rotate':
        if (mode !== null) failUsage()
        mode = flag === '--check' ? 'check' : 'rotate'
        break
      case '--target-version':
        if (targetVersion !== null || !CANONICAL_POSITIVE.test(value ?? '')) failUsage()
        targetVersion = Number(value)
        i++
        break
      case '--confirm-version':
        if (confirmVersion !== null || !CANONICAL_POSITIVE.test(value ?? '')) failUsage()
        confirmVersion = Number(value)
        i++
        break
      case '--writers-paused':
        if (writersPaused) failUsage()
        writersPaused = true
        break
      default:
        failUsage()
    }
  }
  if (mode === null) mode = 'check'
  if (mode === 'rotate') {
    if (targetVersion === null || !writersPaused || confirmVersion === null) failUsage()
    if (confirmVersion !== targetVersion) failUsage()
  } else if (targetVersion !== null || writersPaused || confirmVersion !== null) {
    // Flags that only make sense for --rotate must not ride along with --check.
    failUsage()
  }
  return { mode, targetVersion, writersPaused, confirmVersion }
}

const failUsage = () => { throw new Error('PROOF_ROTATION_CLI_USAGE') }

function nextValue (argv, index) {
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? null : value
}

function printIssues (log, issues) {
  if (issues.length === 0) {
    log.log('issues=none')
    return
  }
  for (const issue of issues) {
    log.log(`issue ${issue.code} proof=${issue.proofId} journal=${issue.journalRole}:${issue.journalId}`)
  }
}

/**
 * Injectable CLI entry (tests pass models/keyProvider/log/exit; production
 * uses the real Prisma client, the env registry, console and process.exit).
 *
 * @param {{argv?: string[], env?: object, models?: object, keyProvider?: object,
 *   log?: object, exit?: (code: number) => void}} seams
 */
export async function runRotationCli (seams = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    models = null,
    keyProvider = null,
    log = console,
    exit = code => process.exit(code)
  } = seams

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch {
    log.error(USAGE)
    exit(EXIT_USAGE)
    return
  }

  let provider
  try {
    provider = keyProvider ?? createPaymentProofKeyProvider(env)
  } catch (err) {
    // Fixed registry/provider codes only (TXPROOF_*); nothing else can escape
    // the factory, and the codes never carry key material.
    log.error(String(err?.message ?? FAILED_LABEL))
    exit(EXIT_USAGE)
    return
  }

  let client = models
  try {
    if (client === null) client = new PrismaClient()
    if (parsed.mode === 'check') {
      const result = await checkPaymentProofInventory({ models: client, keyProvider: provider })
      log.log(`tx-proof-check proofs=${result.counts.proofs} currentVersion=${result.currentVersion} ` +
        `versions=${result.requiredVersions.join(',') || 'none'}`)
      log.log(`missing-versions=${result.missingVersions.join(',') || 'none'}`)
      printIssues(log, result.ownerIssues)
      exit(result.missingVersions.length > 0 || result.ownerIssues.length > 0 ? EXIT_ISSUES : EXIT_OK)
      return
    }
    const result = await rotatePaymentProofs({
      models: client,
      keyProvider: provider,
      targetVersion: parsed.targetVersion,
      writersPaused: true,
      batchSize: 100
    })
    log.log(`tx-proof-rotation targetVersion=${parsed.targetVersion} rotated=${result.rotated} ` +
      `skipped=${result.skipped} conflicts=${result.conflicts} issues=${result.issues.length} ` +
      `versionsBefore=${Object.keys(result.counts.byVersion).join(',') || 'none'} ` +
      `versionsAfter=${Object.keys(result.counts.byVersionAfter).join(',') || 'none'}`)
    printIssues(log, result.issues)
    exit(result.conflicts > 0 || result.issues.length > 0 ? EXIT_ISSUES : EXIT_OK)
  } catch (err) {
    const code = String(err?.message ?? '')
    if (code.startsWith('TXPROOF_')) {
      log.error(code)
      exit(EXIT_USAGE)
      return
    }
    if (FIXED_CODE.test(code)) {
      log.error(code)
    } else {
      // Unexpected failure: a fixed generic label only — never raw driver or
      // library text, which could carry connection strings or row data.
      log.error(FAILED_LABEL)
    }
    exit(EXIT_FAILED)
  } finally {
    if (models === null && client !== null && typeof client.$disconnect === 'function') {
      await client.$disconnect()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRotationCli()
}
