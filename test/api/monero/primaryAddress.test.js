/* eslint-env jest */

// Primary-address screening (mirrors monero-lws src/db/string.cpp: lws
// admin add_account rejects subaddresses and integrated addresses with the
// same error::bad_address as a wrong network). Fixtures are checksum-valid;
// network bytes decode-verified (18/19/42 mainnet, 24/25/36 stagenet).

import { isPrimaryAddress } from '@/api/monero/primaryAddress'

const MAINNET_PRIMARY = '4B9ryEY64fSPjveaDX3dwhcyeYcYtemZ2gHfxg7VeLyR7SS4BbZfgzdVRH46NzB2DpHdhVkegdoP1hG8iWL3HZkQC5WyT1H'
const MAINNET_SUB = '8AG9jwKSAkLiKfbY2XEJAZDcCQSPqiYwCQXcb6H7ysTg5C2rxp4tjdbLFsL18towxdgdov4LmjzE8DuaT4fNntXsMQgDvXk'
const MAINNET_INTEG = '4LrXz3MafvxPjveaDX3dwhcyeYcYtemZ2gHfxg7VeLyR7SS4BbZfgzdVRH46NzB2DpHdhVkegdoP1hG8iWL3HZkQHVrKkNsRATY3niQhuj'
const STAGENET_PRIMARY = '58TzNZ2PKfWJfTsaZvHyWFadMp3GTVNPL2jU66DV47BZGUEAUBzpkVvSZ1uaziDT2mgXZAymK9U9aNhSxc63ARKaUX7u2LL'
const STAGENET_SUB = '76xWgnfS349P5LUqFTQx3DWMgUHcXutpY3ZyHsnz2vx3HiWVj6NKwmsjBnH3MbnpDcDGUkzYAawcG9CaUamznCrfPCyVgd1'
const STAGENET_INTEG = '5JAfPMqsvw2JfTsaZvHyWFadMp3GTVNPL2jU66DV47BZGUEAUBzpkVvSZ1uaziDT2mgXZAymK9U9aNhSxc63ARKahkXrmRbwLFY3pV5qUc'

describe('isPrimaryAddress', () => {
  test('accepts primary addresses of every network', () => {
    expect(isPrimaryAddress(MAINNET_PRIMARY, 'MAINNET')).toBe(true)
    expect(isPrimaryAddress(STAGENET_PRIMARY, 'STAGENET')).toBe(true)
  })

  test('rejects integrated and subaddress variants of the same network (the lws class rule)', () => {
    expect(isPrimaryAddress(MAINNET_INTEG, 'MAINNET')).toBe(false)
    expect(isPrimaryAddress(MAINNET_SUB, 'MAINNET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_INTEG, 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_SUB, 'STAGENET')).toBe(false)
  })

  test('rejects a primary address of a different network', () => {
    expect(isPrimaryAddress(MAINNET_PRIMARY, 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_PRIMARY, 'MAINNET')).toBe(false)
  })

  test('rejects garbage, checksum-tampered, and truncated strings', () => {
    expect(isPrimaryAddress('not-a-real-monero-address', 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_PRIMARY.slice(0, 94) + (STAGENET_PRIMARY.endsWith('1') ? '2' : '1'), 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_PRIMARY.slice(0, 80), 'STAGENET')).toBe(false)
    expect(isPrimaryAddress('1'.repeat(95), 'STAGENET')).toBe(false)
  })

  test('rejects non-string input and unknown networks', () => {
    expect(isPrimaryAddress(undefined, 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(null, 'STAGENET')).toBe(false)
    expect(isPrimaryAddress(STAGENET_PRIMARY, 'FAKECERT')).toBe(false)
  })
})
