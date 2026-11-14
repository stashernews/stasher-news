import { gql } from '@apollo/client'

export const CONTRIBUTOR_POST = gql`query ContributorPost($id: Int!) {
  adminContributorPost(id: $id) { id title authorId authorName deleted disqualifiedAt disqualificationReason note notifyAt version }
}`
export const DISQUALIFIED_CONTRIBUTOR_POSTS = gql`query DisqualifiedContributorPosts($after: String) {
  adminDisqualifiedContributorPosts(after: $after) { total nextCursor rows { id title authorId authorName deleted disqualifiedAt disqualificationReason note notifyAt } }
}`
export const CONTRIBUTOR_RUNS = gql`query ContributorRuns($beforeId: Int) {
  adminContributorRuns(beforeId: $beforeId) { rows { id periodEnd mode status hasSnapshot } nextBeforeId }
}`
export const CONTRIBUTOR_SNAPSHOT = gql`query ContributorSnapshot($id: Int!) {
  adminContributorSnapshot(id: $id) {
    id periodEnd status mode configuredMode available warnings errors windowStart windowEnd windowScored catchUpWeeks
    candidates eligible qualifying nearMisses recordedRows appliedBudget distributedAmount
    exclusions { reason count } parameters { key value }
    funding { curatorTarget contributorTarget room curatorBudget contributorBudget fitBps scaled }
    allocation { paid rolledOver winnerCap combinedCap }
    posts { itemId authorId title authorName available turf rank qualifies tippers trustedTippers trustedTipperAccounts { id name } base breadth commenters commentMultiplier score words lengthMultiplier weight rawShare share trims { rule piconeros } }
  }
}`
export const SET_CONTRIBUTOR_ELIGIBILITY = gql`mutation SetContributorEligibility($id: Int!, $expectedVersion: String!, $disqualified: Boolean!, $disqualificationReason: AdminContributorReason, $note: String, $notifyAuthor: Boolean!, $reason: String!) {
  adminSetContributorEligibility(id: $id, expectedVersion: $expectedVersion, disqualified: $disqualified, disqualificationReason: $disqualificationReason, note: $note, notifyAuthor: $notifyAuthor, reason: $reason) { applyId applied alertDelivered error }
}`
