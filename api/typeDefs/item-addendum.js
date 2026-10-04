import { gql } from 'graphql-tag'

// Post-window addenda (2026-10-04 spec). The save path carries only the
// addendum triple — original-content and monetary fields are unreachable by
// construction (see test/api/item-addendum.test.js schema surface test).
export default gql`
  enum ItemEditMode {
    NONE
    FULL
    ADDENDUM
  }

  extend type Mutation {
    updateItemAddendum(id: ID!, text: String!, expectedRevision: Int!): Item!
  }

  extend type Item {
    editMode: ItemEditMode!
    editExpiresAt: Date
    addendumText: String
    addendumUpdatedAt: Date
    addendumRevision: Int!
    addendumLexicalState: String
    addendumHtml: String
  }
`
