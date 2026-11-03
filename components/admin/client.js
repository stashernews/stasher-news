import { ApolloClient, InMemoryCache, HttpLink, gql } from '@apollo/client'

export function createAdminClient (fetch) {
  return new ApolloClient({
    cache: new InMemoryCache(),
    link: new HttpLink({ uri: '/api/admin/graphql', credentials: 'omit', headers: { 'x-admin-client': '1' }, ...(fetch ? { fetch } : {}) }),
    defaultOptions: { query: { fetchPolicy: 'no-cache' }, mutate: { fetchPolicy: 'no-cache' } }
  })
}

export const DASHBOARD = gql`
  query AdminDashboard {
    adminSections { id label order kind groups fields { key store section group label type min max help takesEffect options unit value effectiveValue source locked lockReason effectiveReason rolloutMode experimental } }
    adminOverview
    adminTreasury
    adminAccess { key label pass detail checkedAt }
    adminEnvironment { key value kind source help }
    adminInviteCodes { id label createdAt revokedAt source }
    adminAudit { rows { id createdAt applyId actor store field targetId oldValue newValue reason applied } nextCursor }
  }
`
export const APPLY = gql`mutation ApplyAdmin($changes: [AdminChangeInput!]!, $reason: String!) { adminApply(changes: $changes, reason: $reason) { applyId applied alertDelivered error } }`
export const CREATE_INVITE = gql`mutation CreateAdminInvite($label: String!, $reason: String!) { adminCreateInviteCode(label: $label, reason: $reason) { id code applyId applied alertDelivered } }`
export const REVOKE_INVITE = gql`mutation RevokeAdminInvite($id: Int!, $reason: String!) { adminRevokeInviteCode(id: $id, reason: $reason) { applyId applied alertDelivered } }`
export const AUDIT = gql`query AdminAuditPage($cursor: String) { adminAudit(cursor: $cursor) { rows { id createdAt applyId actor store field targetId oldValue newValue reason applied } nextCursor } }`
