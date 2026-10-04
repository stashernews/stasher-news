import { gql } from '@apollo/client'

// Post-window addendum (2026-10-04 spec): the single informational edit below
// a locked original. addendumRevision is requested even when the content is
// empty so clearing/recreating stays conflict-safe.
export const ITEM_ADDENDUM_FIELDS = gql`
  fragment ItemAddendumFields on Item {
    id
    addendumText
    addendumUpdatedAt
    addendumRevision
    addendumLexicalState
    addendumHtml
  }`

export const UPDATE_ITEM_ADDENDUM = gql`
  ${ITEM_ADDENDUM_FIELDS}

  mutation UpdateItemAddendum($id: ID!, $text: String!, $expectedRevision: Int!) {
    updateItemAddendum(id: $id, text: $text, expectedRevision: $expectedRevision) {
      ...ItemAddendumFields
    }
  }`
