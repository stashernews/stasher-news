/* eslint-env jest */

// Territory post-type invariant.
//
// A territory's `postTypes` are persisted as a Prisma `PostType[]`. Creating a
// territory whose postTypes include anything NOT in the Prisma PostType enum
// fails server-side with `Invalid value for argument "postTypes". Expected
// PostType`. lib/constants.js POST_TYPES is the source of truth for the
// territory form's checkboxes AND lib/validate.js territorySchema — so every
// entry must be a real enum value or the create path breaks.
//
// BOUNTY was restored as a first-class post type by A-13 (PostType.BOUNTY,
// monero-funded bounties), so POST_TYPES must offer it again.

import { POST_TYPES } from '@/lib/constants'
import { PostType } from '@prisma/client'

describe('POST_TYPES', () => {
  const validPostTypes = Object.values(PostType)

  test('every post type is a valid Prisma PostType enum value', () => {
    for (const postType of POST_TYPES) {
      expect(validPostTypes).toContain(postType)
    }
  })

  test('offers the BOUNTY post type (A-13 funded bounties)', () => {
    expect(POST_TYPES).toContain('BOUNTY')
  })
})
