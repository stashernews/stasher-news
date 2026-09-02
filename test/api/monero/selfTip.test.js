/* eslint-env jest */
import { isSelfSend, shouldExcludeTip, resolveItemSubName } from '@/api/monero/selfTip'

const ACCT = { id: 7, subaddresses: [{ majorIndex: 0, minorIndex: 1 }, { majorIndex: 0, minorIndex: 5 }] }

// lws spent_outputs subaddress shape (verified on dev lws 2026-08-23):
// indices arrive nested under `sender` — the subaddress of the scanned
// account that owned the spent output.
const so = (maj, min) => ({ sender: { maj_i: maj, min_i: min } })

describe('isSelfSend', () => {
  test('true when a spent output matches the primary subaddress (0,0)', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 0), so(4, 2)] })).toBe(true)
  })
  test('true when a spent output matches a registered SubaddressIndex row', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 5)] })).toBe(true)
  })
  test('true for the sender shape', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 1)] })).toBe(true)
  })
  test('false when spent outputs are foreign subaddresses (candidate false-match guard)', () => {
    // a foreign wallet's primary is also (0,0) — but lws only attaches indices
    // decoded against the SCANNED account, so (4,2)/(9,9) are foreign indices
    expect(isSelfSend(ACCT, { spent_outputs: [so(4, 2), so(9, 9)] })).toBe(false)
  })
  test('false when the account has subaddresses but none match', () => {
    const acct = { subaddresses: [{ majorIndex: 1, minorIndex: 0 }] }
    expect(isSelfSend(acct, { spent_outputs: [so(2, 3)] })).toBe(false)
  })
  test('false for empty or missing spent_outputs', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [] })).toBe(false)
    expect(isSelfSend(ACCT, {})).toBe(false)
  })
  test('false for a null tx (payment not found in the scan)', () => {
    expect(isSelfSend(ACCT, null)).toBe(false)
  })
})

describe('shouldExcludeTip', () => {
  const external = { spent_outputs: [so(4, 2)] }
  test('true when tipperId === postUserId (direct self-tip)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: external })).toBe(true)
  })
  test('true when isSelfSend (logged-out self-send from the registered wallet)', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: { spent_outputs: [so(0, 0)] } })).toBe(true)
  })
  test('true when both conditions hold (direct wins as the reason)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: { spent_outputs: [so(0, 0)] } })).toBe(true)
  })
  test('false for a normal attributed tip', () => {
    expect(shouldExcludeTip({ tipperId: 6, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
  test('false for a normal anonymous tip', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
})

describe('resolveItemSubName', () => {
  test('COALESCEs root.subNames[1] over item.subNames[1], null when absent', async () => {
    const queue = [
      [{ subName: 'stasher' }], // first call: root lookup hit
      [{}], // second call: no subNames anywhere (undefined -> null)
      [] // third call: item not found
    ]
    const handle = { $queryRaw: async () => queue.shift() ?? [] }
    expect(await resolveItemSubName(1, handle)).toBe('stasher')
    expect(await resolveItemSubName(2, handle)).toBe(null)
    expect(await resolveItemSubName(3, handle)).toBe(null)
  })
})
