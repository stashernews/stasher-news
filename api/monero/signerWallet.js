// Signer seam for the FCMP stressnet (spec §7): every monero-ts wallet
// construction for platform signers goes through here, so the eventual
// FCMP-compatible monero-ts release is adopted in ONE file.
//
// MONERO_SIGNER_ENABLED gates sends off on networks the embedded wallet2
// build cannot construct txs for (the FCMP stressnet after its fork — 0.18-era
// wallet2 cannot build FCMP transactions). The gate FAILS OPEN by design:
// unset/garbage means ENABLED. Mainnet must never silently stop paying.
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'

export function signerEnabled () {
  const v = process.env.MONERO_SIGNER_ENABLED
  if (v === undefined) return true
  const s = String(v).trim()
  // Exact tokens only — deliberate case-sensitive fail-open ('FALSE'/'No' enable).
  return !(s === 'false' || s === '0' || s === 'no')
}

// Loud, deduped CRITICAL nag for skipped signer jobs — visible in ops dashboards
// (same posture as the out-of-window-payout nag), self-healing when the env is
// cleared. Returns false so callers can `return signerDisabledNag(label)`.
export function signerDisabledNag (label) {
  alert('critical', 'monero signer disabled',
    `${label}: MONERO_SIGNER_ENABLED is false — payout/sweep runs are skipping. Expected on the FCMP stressnet after the fork (monero-ts has no FCMP support yet); it must NEVER be set on mainnet.`,
    { dedupeKey: `signer-disabled-${label}` })
  logError({ label }, 'signerWallet: CRITICAL — signer disabled, job skipped')
  return false
}

// 3-way network mapping. This centralization FIXES a latent bug: bounties.js
// and feePoolDerive.js mapped non-mainnet → STAGENET (2-way), so on testnet
// they opened stagenet wallets against a testnet daemon.
export function resolveSignerNetworkType (api, env) {
  const n = String(env || 'stagenet').toLowerCase()
  if (n === 'mainnet') return api.MoneroNetworkType.MAINNET
  if (n === 'testnet') return api.MoneroNetworkType.TESTNET
  return api.MoneroNetworkType.STAGENET
}

// In-memory wallet (no `path`): reopened from keys each worker boot, so there
// is no on-disk wallet file to conflict on restart. `password` is a
// required-but-meaningless placeholder for an in-memory wallet — NOT a secret.
// proxyToWorker:false keeps scanning in the calling thread, matching the
// previous inline construction in rewards.js/bounties.js.
export async function createSignerWallet ({ password, primaryAddress, privateSpendKey, privateViewKey, restoreHeight, serverUri }) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = resolveSignerNetworkType(api, process.env.MONERO_NETWORK)
  return api.createWalletFull({
    password,
    networkType,
    primaryAddress,
    privateSpendKey,
    privateViewKey,
    restoreHeight,
    server: { uri: serverUri },
    proxyToWorker: false
  })
}
