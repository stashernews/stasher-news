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
// BOUNTY was the offender: it survived in POST_TYPES (and the territory form)
// after the custodial strip dropped BOUNTY from the PostType enum (which only
// supports LINK, DISCUSSION, JOB, POLL).

import { POST_TYPES } from '@/lib/constants'
import { PostType } from '@prisma/client'

describe('POST_TYPES', () => {
  const validPostTypes = Object.values(PostType)

  test('every post type is a valid Prisma PostType enum value', () => {
    for (const postType of POST_TYPES) {
      expect(validPostTypes).toContain(postType)
    }
  })

  test('does not offer the defunct BOUNTY post type', () => {
    expect(POST_TYPES).not.toContain('BOUNTY')
  })
})
