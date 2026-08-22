/* eslint-env jest */
import { GraphQLError } from 'graphql'
import { formatGraphqlError } from '@/lib/formatGraphqlError'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'

const FIXED_UUID = () => 'aaaabbbb-cccc-4ddd-eeee-ffff00001111'

// what Apollo Server hands formatError after wrapping a raw resolver error
function wrappedResolverError (message) {
  return new GraphQLError(message, {
    originalError: new Error(message),
    path: ['item']
  })
}

test('coded Gql errors pass through untouched and are not logged', () => {
  const logError = jest.fn()
  for (const err of [new GqlAuthenticationError(), new GqlInputError('name taken')]) {
    const formatted = { message: err.message, extensions: err.extensions }
    const out = formatGraphqlError(formatted, err, { logError, randomUUID: FIXED_UUID })
    expect(out).toBe(formatted)
  }
  expect(logError).not.toHaveBeenCalled()
})

test('graphql-js errors without a code (validation/parse) pass through untouched', () => {
  const logError = jest.fn()
  const validation = new GraphQLError("Variable '$id' of required type 'ID!' was not provided.")
  const formatted = { message: validation.message }
  const out = formatGraphqlError(formatted, validation, { logError, randomUUID: FIXED_UUID })
  expect(out).toBe(formatted)
  expect(logError).not.toHaveBeenCalled()
})

test('unexpected resolver error in dev: keeps real message, adds extensions.errorId, logs mapping', () => {
  const logError = jest.fn()
  const original = wrappedResolverError('Prisma connection reset')
  const formatted = { message: 'Prisma connection reset', path: ['item'], extensions: { code: 'INTERNAL_SERVER_ERROR' } }

  const out = formatGraphqlError(formatted, original, { logError, randomUUID: FIXED_UUID, isProd: false })

  expect(out.message).toBe('Prisma connection reset')
  expect(out.extensions.errorId).toBe('aaaabbbb')
  expect(logError).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith(
    { errorId: 'aaaabbbb', code: 'INTERNAL_SERVER_ERROR', message: 'Prisma connection reset' },
    'unexpected GraphQL error')
})

test('unexpected resolver error in prod: message masked with id, original logged server-side', () => {
  const logError = jest.fn()
  const original = wrappedResolverError('Prisma connection reset')
  const formatted = { message: 'Prisma connection reset', path: ['item'], locations: [{ line: 3, column: 7 }], extensions: { code: 'INTERNAL_SERVER_ERROR' } }

  const out = formatGraphqlError(formatted, original, { logError, randomUUID: FIXED_UUID, isProd: true })

  expect(out.message).toBe('Internal server error (id: aaaabbbb)')
  expect(out.path).toEqual(['item'])
  expect(out.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', errorId: 'aaaabbbb' })
  expect(logError).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Prisma connection reset' }), 'unexpected GraphQL error')
})

test('unexpected error without any code extension is also stamped', () => {
  const logError = jest.fn()
  const original = wrappedResolverError('boom')
  const formatted = { message: 'boom', path: ['item'] }

  const out = formatGraphqlError(formatted, original, { logError, randomUUID: FIXED_UUID, isProd: false })

  expect(out.extensions.errorId).toBe('aaaabbbb')
})
