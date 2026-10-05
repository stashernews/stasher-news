// Read-only dry-run / explicit CHECK publication / guarded APPLY for the
// rewards-wallet accounting repair (rewards accounting repair §8, Task 13).
//
//   dev dry-run:
//     docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json \
//       scripts/reconcile-rewards-wallet.js --output /tmp/rewards-repair-report.json
//
//   VPS (loader-wrapped, canonical four-file prod chain — see the operator
//   runbook at docs/ops/rewards-wallet-accounting-repair.md):
//     NODE_ENV=production docker compose --env-file .env.development \
//       --env-file .env.local -f docker-compose.yml -f docker-compose.volumes.yml \
//       -f docker-compose.override.yml -f docker-compose.prodmode.yml \
//       run --rm -T --no-deps \
//       --entrypoint /etc/stashernews/scripts/load-secrets-local.sh \
//       app npx tsx --tsconfig jsconfig.json scripts/reconcile-rewards-wallet.js <mode flags>
//
// Modes (exactly one):
//   --output <path>                       dry-run report (default mode; the flag
//                                         is optional and only names the report file)
//   --publish-check [--output <path>]     explicitly persist a scoped CHECK audit row
//   --apply <path> --confirm <sha256> --backup-reference <ref> --writers-paused
//
// `--decisions <path>` supplies the reviewed operator decisions JSON used when
// building the manifest (receipt classifications, verified historical period
// configs, explicit receipt allocations and first-carry provenance). Without
// them the manifest stays fail-closed on every unknown classification.
//
// Discipline: the dry-run and CHECK paths write nothing except the requested
// report file and (for --publish-check) the audit row; APPLY rescans the chain
// read-only, re-verifies the approved boundary block hash and stable chain
// facts, then atomically applies the confirmed manifest. This script never
// imports or calls a signer / payout / sweep / recovery operation, never opens
// the signer singleton, never broadcasts, and never queues work. Wallet keys are
// read from the environment only; printed errors are redacted.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { daemonClient } from '@/api/monero/daemonClient'
import { collectRewardsWalletEvidence } from '@/api/monero/rewardsWalletEvidence'
import { applyRewardsReconciliation } from '@/api/monero/applyRewardsReconciliation'
import {
  buildRewardsReconciliation,
  chainFactsFingerprint,
  manifestDigest,
  normalizeEvidence,
  readRepairLedger
} from '@/api/monero/rewardsReconciliation'
import { walletScope } from '@/lib/rewardsAccounting'

const HEX64_RE = /^[0-9a-f]{64}$/
const VALUE_FLAGS = new Set(['--output', '--decisions', '--apply', '--confirm', '--backup-reference'])
const BOOLEAN_FLAGS = new Set(['--publish-check', '--writers-paused'])
// Credential env vars the audit touches. Their VALUES are never printed; any
// occurrence in an error message is replaced before output.
const SECRET_ENV_KEYS = [
  'PLATFORM_REWARDS_SPEND_KEY',
  'PLATFORM_REWARDS_VIEW_KEY',
  'BOUNTY_ESCROW_SPEND_KEY',
  'BOUNTY_ESCROW_VIEW_KEY',
  'PLATFORM_REWARDS_ADDRESS',
  'BOUNTY_ESCROW_ADDRESS'
]

export const USAGE = [
  'Usage:',
  '  reconcile-rewards-wallet.js [--decisions <path>] [--output <path>]',
  '  reconcile-rewards-wallet.js --publish-check [--decisions <path>] [--output <path>]',
  '  reconcile-rewards-wallet.js --apply <path> --confirm <sha256> --backup-reference <reference> --writers-paused',
  '',
  '--output writes the dry-run report (manifest + approved evidence, mode 0600, never overwrites).',
  '--publish-check persists a scoped CHECK audit row with the sanitized evidence and real measured drift.',
  '--apply reads a previously written report, rescans the chain read-only and applies the confirmed manifest.',
  'Unknown or repeated flags and extra positional arguments are rejected.'
].join('\n')

// Strict flag parser: every token must be a known flag or a value for one, a
// value cannot itself start with `--`, repeated flags are refused, and mode
// combinations are validated before any client/wallet is touched.
export function parseArgs (argv) {
  if (!Array.isArray(argv)) throw new Error('arguments must be an array')
  const seen = new Map()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (BOOLEAN_FLAGS.has(token)) {
      if (seen.has(token)) throw new Error(`repeated argument: ${token}`)
      seen.set(token, true)
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      if (seen.has(token)) throw new Error(`repeated argument: ${token}`)
      const value = argv[i + 1]
      if (value == null || value.startsWith('--')) throw new Error(`missing value for ${token}`)
      seen.set(token, value)
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }

  const options = {
    mode: 'dry-run',
    output: seen.get('--output') ?? null,
    decisions: seen.get('--decisions') ?? null,
    apply: seen.get('--apply') ?? null,
    confirm: seen.get('--confirm') ?? null,
    backupReference: seen.get('--backup-reference') ?? null,
    writersPaused: seen.get('--writers-paused') === true,
    publishCheck: seen.get('--publish-check') === true
  }

  if (options.apply != null) {
    options.mode = 'apply'
    if (options.publishCheck) throw new Error('--apply cannot be combined with --publish-check')
    if (options.confirm == null) throw new Error('--apply requires --confirm <sha256>')
    if (!HEX64_RE.test(options.confirm)) throw new Error('--confirm must be the manifest SHA-256 (64 lowercase hex characters)')
    if (options.backupReference == null) throw new Error('--apply requires --backup-reference <reference>')
    if (options.backupReference.trim() === '') throw new Error('--backup-reference must not be empty')
    if (!options.writersPaused) throw new Error('--apply requires --writers-paused')
    if (options.output != null) throw new Error('--apply does not write a report; --output is not accepted')
    if (options.decisions != null) throw new Error('--apply uses the decisions already bound into the manifest; --decisions is not accepted')
  } else if (options.publishCheck) {
    options.mode = 'publish-check'
    rejectApplyOnlyFlags(seen, '--publish-check')
  } else {
    rejectApplyOnlyFlags(seen, 'dry-run')
  }
  return options
}

function rejectApplyOnlyFlags (seen, mode) {
  for (const flag of ['--confirm', '--backup-reference', '--writers-paused']) {
    if (seen.has(flag)) throw new Error(`${mode} does not accept ${flag}`)
  }
}

// Redact configured credential values and any 64-hex secret from an error
// message before it is printed. Never echoes argv or env values.
export function redactSecrets (message) {
  let out = String(message ?? '')
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length >= 8) out = out.split(value).join('[redacted]')
  }
  return out.replace(/[0-9a-f]{64}/gi, '[redacted-hash]')
}

function loadJsonFile (path, label) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${label} not found or unreadable: ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function loadDecisions (path) {
  if (path == null) return { decisions: {}, opsCarryProvenance: {} }
  const file = loadJsonFile(path, 'decisions file')
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('decisions file must be a JSON object')
  for (const [key, type] of [['receipts', 'object'], ['periodConfigs', 'array'], ['receiptAllocations', 'object'], ['opsCarryProvenance', 'object']]) {
    const value = file[key]
    if (value == null) continue
    if (type === 'array' ? !Array.isArray(value) : typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`decisions file ${key} must be a JSON ${type}`)
    }
  }
  return {
    decisions: {
      receipts: file.receipts ?? {},
      periodConfigs: file.periodConfigs ?? [],
      receiptAllocations: file.receiptAllocations ?? {}
    },
    opsCarryProvenance: file.opsCarryProvenance ?? {}
  }
}

// Immutable report file: exclusive creation (an existing file — including any
// input — is never overwritten) and mode 0600.
function writeReportFile (path, report) {
  const resolved = resolve(path)
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return resolved
}

// The standing reserve inputs the manifest totals are computed with, read from
// the same env vars (and defaults) api/monero/rewards.js uses.
function reserveInputs () {
  return {
    feeHeadroomPiconeros: BigInt(process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS || '1000000000'),
    dustFloorPiconeros: BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')
  }
}

// Build the manifest from a fresh read-only evidence collection and scoped
// ledger read. Shared by dry-run and publish-check.
async function buildApprovedReport ({ models, scope, collectEvidence, decisionsFile }) {
  const { decisions, opsCarryProvenance } = loadDecisions(decisionsFile)
  const evidence = await collectEvidence({ models, scope })
  const ledger = await readRepairLedger(models, scope)
  const manifest = buildRewardsReconciliation({
    scope,
    boundary: evidence.boundary,
    evidence,
    ledger,
    decisions,
    config: ledger.config,
    reserve: reserveInputs(),
    opsCarryProvenance
  })
  return { manifest, evidence: normalizeEvidence(evidence) }
}

async function executeDryRun (options, context) {
  const { models, log } = context
  const scope = context.scope()
  const report = await buildApprovedReport({ models, scope, collectEvidence: context.collectEvidence, decisionsFile: options.decisions })
  let output = null
  if (options.output != null) {
    output = writeReportFile(options.output, report)
    log(`wrote repair report: ${output}`)
  }
  log(`dry-run manifest ${report.manifest.digest} (${report.manifest.operations.length} operation(s), ${report.manifest.issues.length} issue(s), positive drift ${report.manifest.after.positiveDriftPiconeros} piconeros)`)
  return { mode: 'dry-run', digest: report.manifest.digest, output, manifest: report.manifest }
}

async function executePublishCheck (options, context) {
  const { models, log } = context
  const scope = context.scope()
  const report = await buildApprovedReport({ models, scope, collectEvidence: context.collectEvidence, decisionsFile: options.decisions })
  const { manifest } = report
  // The CURRENT measured drift (`before`), never the hypothetical post-repair
  // drift: a CHECK records what the ledger shows NOW, so it can never clear a
  // real discrepancy before the corrections are applied. The exact manifest
  // (including every material issue) is persisted, and the ledger consumer only
  // lets an issue-free audit clear the reconciliation gate.
  const data = {
    digest: manifest.digest,
    kind: 'CHECK',
    network: manifest.scope.network,
    walletAddress: manifest.scope.walletAddress,
    height: manifest.boundary.height,
    blockHash: manifest.boundary.blockHash,
    ledgerFingerprint: manifest.ledgerFingerprint,
    evidenceDigest: manifest.evidenceDigest,
    positiveDriftPiconeros: BigInt(manifest.before.positiveDriftPiconeros),
    report,
    checkedAt: new Date()
  }
  let published = true
  try {
    await models.rewardsWalletReconciliation.create({ data })
  } catch (err) {
    if (err?.code === 'P2002') published = false
    else throw err
  }
  if (!published) log(`CHECK for manifest ${manifest.digest} is already published — no-op`)
  else log(`published CHECK ${manifest.digest} (${manifest.issues.length} issue(s), positive drift ${manifest.after.positiveDriftPiconeros} piconeros)`)
  if (manifest.issues.length > 0) {
    log('CHECK NOT CLEAN: material accounting issue(s) remain — this publication does not authorize an apply or any send')
  }
  let output = null
  if (options.output != null) {
    output = writeReportFile(options.output, report)
    log(`wrote repair report: ${output}`)
  }
  return { mode: 'publish-check', digest: manifest.digest, published, output, manifest }
}

async function executeApply (options, context) {
  const { models, daemon, collectEvidence, apply, log } = context
  const file = loadJsonFile(options.apply, 'apply report')
  const manifest = file?.manifest
  const approvedEvidence = file?.evidence
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('apply report does not contain a manifest')
  }
  if (!approvedEvidence || typeof approvedEvidence !== 'object' || Array.isArray(approvedEvidence)) {
    throw new Error('apply report does not contain the approved evidence')
  }
  if (options.confirm !== manifest.digest || manifestDigest(manifest) !== manifest.digest) {
    throw new Error('apply report manifest does not match the confirmed SHA-256')
  }

  // Read-only rescan. A failed rescan aborts the apply: the approved evidence
  // is never reused as fresh permission to proceed.
  const fresh = await collectEvidence({ models, scope: manifest.scope })
  log(`rescan boundary ${fresh.boundary?.height ?? 'unknown'} (approved ${manifest.boundary.height})`)

  // The approved fixed boundary must still be canonical: a reorg below it
  // invalidates every fact the manifest was built from.
  if (typeof daemon?.getBlockHashByHeight !== 'function') {
    throw new Error('an injected daemon with getBlockHashByHeight is required')
  }
  const liveBoundaryHash = String(await daemon.getBlockHashByHeight(manifest.boundary.height)).toLowerCase()
  if (!HEX64_RE.test(liveBoundaryHash) || liveBoundaryHash !== manifest.boundary.blockHash) {
    throw new Error('the approved boundary block hash is no longer canonical; a new manifest and review are required')
  }

  // Stable confirmed chain facts must be unchanged. The tip may advance (and
  // confirmations/unlocked balances may move) while the approved facts still
  // hold; any changed accounting fact requires a new manifest.
  if (chainFactsFingerprint(fresh) !== chainFactsFingerprint(approvedEvidence)) {
    throw new Error('the rescan shows changed chain facts (the tip advanced incompatibly); a new manifest and review are required')
  }

  const result = await apply({
    models,
    manifest,
    evidence: approvedEvidence,
    confirmedDigest: options.confirm,
    backupReference: options.backupReference,
    writersPaused: options.writersPaused
  })
  log(result.applied
    ? `APPLIED repair ${result.digest}`
    : `repair ${result.digest} was already applied — replay no-op`)
  return { mode: 'apply', applied: result.applied, digest: result.digest }
}

/**
 * Execute the CLI. Dependencies are injectable so the smoke tests can prove the
 * dry-run makes zero writes and the apply never reaches a signer.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<object>} a small structured result.
 */
export async function runCli (argv, deps = {}) {
  const options = parseArgs(argv)
  const log = deps.log ?? (message => console.log(message))
  const models = deps.models ?? new PrismaClient()
  const ownsModels = deps.models == null
  const context = {
    models,
    daemon: deps.daemon ?? daemonClient,
    collectEvidence: deps.collectEvidence ?? collectRewardsWalletEvidence,
    apply: deps.apply ?? applyRewardsReconciliation,
    scope: typeof deps.scope === 'function' ? deps.scope : () => deps.scope ?? walletScope(),
    log
  }
  try {
    if (options.mode === 'apply') return await executeApply(options, context)
    if (options.mode === 'publish-check') return await executePublishCheck(options, context)
    return await executeDryRun(options, context)
  } finally {
    if (ownsModels && typeof models.$disconnect === 'function') {
      try {
        await models.$disconnect()
      } catch { /* a disconnect failure must not mask the operation result */ }
    }
  }
}

const isDirectRun = typeof require !== 'undefined' && require.main === module
if (isDirectRun) {
  runCli(process.argv.slice(2))
    .catch(err => {
      console.error(`reconcile-rewards-wallet failed: ${redactSecrets(err?.message ?? err)}`)
      console.error(USAGE)
      process.exitCode = 1
    })
}
