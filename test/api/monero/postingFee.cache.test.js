/* eslint-env jest */
import { getCachedPlatformFeeConfig, clearFeeConfigCache } from '@/api/monero/postingFee'

// The fee-config cache is a module-level singleton shared by every resolver in
// the process. These tests pin its two required behaviors: reads within the
// TTL are served from cache, and an admin apply's clear cannot be undone by an
// in-flight read that started before the apply.
describe('fee config cache', () => {
  beforeEach(() => clearFeeConfigCache())

  test('reads within the TTL are served from cache', async () => {
    let reads = 0
    const models = {
      platformFeeConfig: {
        findUnique: async () => {
          reads += 1
          return { id: 1, postingFeeFloorPiconeros: 1000000000n }
        }
      }
    }
    await getCachedPlatformFeeConfig(models)
    await getCachedPlatformFeeConfig(models)
    expect(reads).toBe(1)
  })

  test('an in-flight read must not repopulate the cache after an admin apply clears it', async () => {
    let releaseFirstRead
    const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve })
    let reads = 0
    const config = { id: 1, postingFeeFloorPiconeros: 1000000000n }
    const models = {
      platformFeeConfig: {
        findUnique: async () => {
          reads += 1
          if (reads === 1) await firstReadGate
          return config
        }
      }
    }

    // A read starts and stalls on its query...
    const inFlight = getCachedPlatformFeeConfig(models)
    // ...an admin apply commits and clears the cache mid-read...
    clearFeeConfigCache()
    // ...then the stale read finally resolves.
    releaseFirstRead()
    await inFlight

    // The next read must re-query: the in-flight read may not have written its
    // pre-apply snapshot into the cleared cache.
    await getCachedPlatformFeeConfig(models)
    expect(reads).toBe(2)
  })
})
