import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import { unwrapResolverError } from '@apollo/server/errors'
import { startServerAndCreateNextHandler } from '@as-integrations/next'
import { GraphQLError } from 'graphql'
import { depthLimit } from '@graphile/depth-limit'
import models from '@/api/models'
import typeDefs from '@/api/admin/typeDefs'
import resolvers from '@/api/admin/resolvers'
import { isAdminRequest, assertAdminMutationOrigin } from '@/lib/admin/guard'
import { AdminError } from '@/lib/admin/validate'

export const adminServer = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: false,
  includeStacktraceInErrorResponses: false,
  validationRules: [depthLimit({ maxDepth: 8, maxListDepth: 4 })],
  formatError (formatted, original) {
    const error = unwrapResolverError(original)
    if (error instanceof AdminError) return { message: error.message, extensions: { code: error.code, keys: error.keys } }
    if (['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT', 'FORBIDDEN'].includes(formatted.extensions?.code)) return formatted
    return { message: 'admin request failed', extensions: { code: 'INTERNAL_SERVER_ERROR' } }
  },
  plugins: [ApolloServerPluginLandingPageDisabled(), {
    async requestDidStart () {
      return {
        async didResolveOperation ({ operation, request }) {
          if (operation.operation !== 'mutation') return
          try { assertAdminMutationOrigin({ headers: request.http?.headers }) } catch {
            throw new GraphQLError('admin client marker required', { extensions: { code: 'FORBIDDEN', http: { status: 403 } } })
          }
        }
      }
    }
  }]
})

const apolloHandler = startServerAndCreateNextHandler(adminServer, { context: async () => ({ models }) })

export default function handler (req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!isAdminRequest(req)) return res.status(404).end()
  return apolloHandler(req, res)
}
