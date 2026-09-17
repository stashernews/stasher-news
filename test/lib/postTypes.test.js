/* eslint-env jest */

// Territory post-type invariant.
//
// A territory's `postTypes` are persisted as a Prisma `PostType[]`. Creating a
// territory whose postTypes include anything NOT in the Prisma PostType enum
// fails server-side with `Invalid value for argument "postTypes". Expected
// PostType`. lib/constants.js POST_TYPES is the source of truth for the
// territory form's checkboxes AND lib/validate.js territorySchema — so the two
// sets must match EXACTLY: every enum value must be offered (a value present in
// the DB but absent here makes turfs holding it unsaveable — the JOB bug), and
// every offered value must be a real enum value or the create path breaks.
//
// BOUNTY was restored as a first-class post type by A-13 (PostType.BOUNTY,
// monero-funded bounties). JOB remains in POST_TYPES/POST_TYPE_LABELS for
// legacy turfs, but it is removal-only (excluded from DEFAULT_POST_TYPES):
// job identity is the `jobs` turf (lib/item.js isJob), not a turf postType.

import { POST_TYPES, POST_TYPE_LABELS, DEFAULT_POST_TYPES } from '@/lib/constants'
import { PostType } from '@prisma/client'

describe('POST_TYPES', () => {
  test('covers every Prisma PostType enum value exactly', () => {
    expect([...POST_TYPES].sort()).toEqual(Object.values(PostType).sort())
  })

  test('offers the BOUNTY post type (A-13 funded bounties)', () => {
    expect(POST_TYPES).toContain('BOUNTY')
  })

  test('every post type has a checkbox label', () => {
    for (const postType of POST_TYPES) {
      expect(POST_TYPE_LABELS[postType]).toBeTruthy()
    }
  })

  test('DEFAULT_POST_TYPES is every post type except the legacy JOB', () => {
    expect(DEFAULT_POST_TYPES).not.toContain('JOB')
    expect([...DEFAULT_POST_TYPES].sort()).toEqual(Object.values(PostType).filter(p => p !== 'JOB').sort())
  })
})
