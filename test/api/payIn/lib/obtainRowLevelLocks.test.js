/* eslint-env jest */
import { obtainRowLevelLocks } from '@/api/payIn/lib/obtainRowLevelLocks'

// Regression test for the "Cannot read properties of undefined (reading 'map')"
// crash that blocked every StasherNews fee-based payIn (territory create, posting,
// territory billing, downvote). Those payIns return piconeros=0n with NO
// payOutCustodialTokens key, so obtainRowLevelLocks must tolerate its absence.

function makeTx () {
  const calls = []
  const tx = {
    $executeRaw (...args) {
      calls.push(args)
      return Promise.resolve(1)
    }
  }
  tx._calls = calls
  return tx
}

describe('obtainRowLevelLocks', () => {
  test('does not throw when payOutCustodialTokens is undefined (piconeros:0 fee prospect)', async () => {
    const tx = makeTx()
    const payIn = { userId: 7 }
    await expect(obtainRowLevelLocks(tx, payIn)).resolves.toBeUndefined()
    expect(tx._calls).toHaveLength(1)
  })

  test('does not throw when payOutCustodialTokens is an empty array', async () => {
    const tx = makeTx()
    const payIn = { userId: 7, payOutCustodialTokens: [] }
    await expect(obtainRowLevelLocks(tx, payIn)).resolves.toBeUndefined()
    expect(tx._calls).toHaveLength(1)
  })

  test('locks the union of payOutCustodialTokens userIds and payIn.userId', async () => {
    const tx = makeTx()
    const payIn = {
      userId: 7,
      payOutCustodialTokens: [{ userId: 1 }, { userId: 2 }, { userId: 1 }]
    }
    await obtainRowLevelLocks(tx, payIn)
    expect(tx._calls).toHaveLength(1)
  })
})
