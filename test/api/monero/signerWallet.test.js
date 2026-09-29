/* eslint-env jest */

// Signer seam for the FCMP stressnet (spec §7): every monero-ts wallet
// construction for platform signers funnels through api/monero/signerWallet.js,
// and MONERO_SIGNER_ENABLED gates sends on networks the embedded wallet2 build
// cannot construct txs for (stressnet post-fork). The gate must FAIL OPEN:
// unset/garbage means ENABLED — mainnet must never silently stop paying.

import { signerEnabled, resolveSignerNetworkType } from '@/api/monero/signerWallet'

describe('signerEnabled', () => {
  const ORIGINAL = process.env.MONERO_SIGNER_ENABLED
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MONERO_SIGNER_ENABLED
    else process.env.MONERO_SIGNER_ENABLED = ORIGINAL
  })

  it('defaults to enabled when unset', () => {
    delete process.env.MONERO_SIGNER_ENABLED
    expect(signerEnabled()).toBe(true)
  })

  it.each(['false', '0', 'no'])('is disabled only for exact %j', (v) => {
    process.env.MONERO_SIGNER_ENABLED = v
    expect(signerEnabled()).toBe(false)
  })

  it.each(['', 'garbage', 'FALSE'])('treats %j as enabled (fail-open)', (v) => {
    process.env.MONERO_SIGNER_ENABLED = v
    expect(signerEnabled()).toBe(true)
  })
})

describe('resolveSignerNetworkType', () => {
  const api = { MoneroNetworkType: { MAINNET: 'main', STAGENET: 'stage', TESTNET: 'test' } }

  it('maps testnet (bounties.js/feePoolDerive.js were 2-way — stagenet fallback bug)', () => {
    expect(resolveSignerNetworkType(api, 'testnet')).toBe('test')
  })

  it('maps mainnet', () => {
    expect(resolveSignerNetworkType(api, 'mainnet')).toBe('main')
  })

  it('falls back to stagenet for unset/unknown', () => {
    expect(resolveSignerNetworkType(api, undefined)).toBe('stage')
    expect(resolveSignerNetworkType(api, 'weird')).toBe('stage')
  })
})
