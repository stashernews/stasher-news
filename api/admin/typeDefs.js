import { gql } from 'graphql-tag'

export default gql`
  scalar AdminOverviewData
  type AdminField {
    key: String!, store: String!, section: String!, group: String!, label: String!
    type: String!, min: String, max: String, help: String!, takesEffect: String!
    options: [String!], unit: String, maxLength: Int, value: String!, effectiveValue: String!
    source: String!, locked: Boolean!, lockReason: String, effectiveReason: String
    rolloutMode: Boolean!, experimental: Boolean!
  }
  type AdminSection { id: String!, label: String!, order: Int!, kind: String!, groups: [String!]!, fields: [AdminField!]! }
  type AdminEnvironmentRow { key: String!, value: String!, kind: String!, source: String!, help: String! }
  type AdminAccessRow { key: String!, label: String!, pass: Boolean!, detail: String!, checkedAt: String }
  type AdminInviteCode { id: Int, label: String!, createdAt: String, revokedAt: String, source: String! }
  type AdminAuditRow { id: String!, createdAt: String!, applyId: String!, actor: String!, store: String!, field: String!, targetId: String, oldValue: String!, newValue: String!, reason: String!, applied: Boolean! }
  type AdminAuditPage { rows: [AdminAuditRow!]!, nextCursor: String }
  type AdminApplyResult { applyId: String!, applied: Boolean!, alertDelivered: Boolean!, error: String }
  type AdminCreateInviteResult { applyId: String!, applied: Boolean!, alertDelivered: Boolean!, id: Int!, code: String! }
  input AdminChangeInput { key: String!, expected: String!, value: String!, confirmedJump: Boolean }
  type Query {
    adminOverview: AdminOverviewData!
    adminTreasury: AdminOverviewData!
    adminSections: [AdminSection!]!
    adminAudit(cursor: String): AdminAuditPage!
    adminAccess: [AdminAccessRow!]!
    adminEnvironment: [AdminEnvironmentRow!]!
    adminInviteCodes: [AdminInviteCode!]!
  }
  type Mutation {
    adminApply(changes: [AdminChangeInput!]!, reason: String!): AdminApplyResult!
    adminCreateInviteCode(label: String!, reason: String!): AdminCreateInviteResult!
    adminRevokeInviteCode(id: Int!, reason: String!): AdminApplyResult!
  }
`
