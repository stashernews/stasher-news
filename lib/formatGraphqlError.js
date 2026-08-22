import { GraphQLError } from 'graphql'
import { unwrapResolverError } from '@apollo/server/errors'
import { randomUUID } from 'node:crypto'
import { logError } from '@/lib/logger'

// Stamp every UNEXPECTED GraphQL error with a short errorId so user reports of
// "Internal server error (id: xxxx)" are greppable against pino logs, and mask
// the real message in production (Apollo Server 5 does not mask messages
// itself — only stacktraces are omitted automatically).
//
// Expected errors pass through untouched:
//   - anything with a deliberate extensions.code (our Gql* classes: E_FORBIDDEN,
//     E_UNAUTHENTICATED, E_BAD_INPUT, E_VAULT_KEY_EXISTS, E_PAY_IN_RETRY_RACE)
//   - graphql-js errors (validation/parse) — unwrapped GraphQLErrors; clients
//     legitimately need those messages
// Everything else (raw JS/Prisma errors wrapped by Apollo at the resolver
// boundary — those wraps carry path + originalError) gets the errorId treatment.
export function formatGraphqlError (formattedError, error, opts = {}) {
  const uuid = opts.randomUUID || randomUUID
  const log = opts.logError || logError
  const isProd = opts.isProd !== undefined ? opts.isProd : process.env.NODE_ENV === 'production'

  const code = formattedError.extensions?.code
  if (code && code !== 'INTERNAL_SERVER_ERROR') {
    return formattedError
  }
  if (unwrapResolverError(error) instanceof GraphQLError) {
    return formattedError
  }

  const errorId = uuid().slice(0, 8)
  const originalMessage = error?.message ?? formattedError.message
  log({ errorId, code: code || 'INTERNAL_SERVER_ERROR', message: originalMessage }, 'unexpected GraphQL error')

  if (!isProd) {
    return {
      ...formattedError,
      extensions: { ...formattedError.extensions, errorId }
    }
  }
  return {
    ...formattedError,
    message: `Internal server error (id: ${errorId})`,
    extensions: { code: 'INTERNAL_SERVER_ERROR', errorId }
  }
}
