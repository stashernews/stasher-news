import { gql } from '@apollo/client'

// Single source of truth for the User optional badge fields (streak, hasWallet,
// tippedRecently). It lives in its own module with no app imports so every
// fragment file can embed it without import cycles (replaces the "we can't
// import from users" duplication that used to live in items/comments/users/subs).
//
// IMPORTANT: graphql-tag only dedupes same-named fragments when their content
// is byte-identical. If this definition ever diverges from another copy, every
// document that combines two of them throws "There can be only one fragment
// named StreakFields" (2026-08-18: comments.js added hasAttachedWallet to its
// copy and broke 23 documents, including all posting mutations). New optional
// fields needed on a subset of surfaces belong in a uniquely-named fragment
// alongside this one — NOT added here.
export const STREAK_FIELDS = gql`
  fragment StreakFields on User {
    optional {
      streak
      hasWallet
      tippedRecently
    }
  }
`
