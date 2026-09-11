/* eslint-env jest */
import { API_KEY_BLOCKED_MUTATIONS, apiKeyGuardPlugin, isApiKeyBlocked } from '@/lib/apiKeyGuard'
import { GqlAuthorizationError } from '@/lib/error'

const SENSITIVE = [
  'act',
  'unlinkAuth', 'generateApiKey', 'deleteApiKey', 'setName', 'setSettings',
  'registerMoneroAccount', 'unregisterMoneroAccount', 'initiateTip',
  'fundBounty', 'payBounty', 'reclaimBounty', 'rolloverBounty',
  'createInvite', 'revokeInvite', 'linkPhrase', 'createAuth',
  'transferTerritory', 'setDomain', 'retryPayIn', 'paySub',
  'donateToRewards', 'pollVote', 'upsertSub', 'unarchiveTerritory',
  'savePushSubscription', 'deletePushSubscription', 'setPhoto', 'cropPhoto',
  'updateNoteId'
]

describe('isApiKeyBlocked', () => {
  test('blocks every sensitive mutation for an API-key session', () => {
    for (const fieldName of SENSITIVE) {
      expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName })).toBe(true)
    }
  })

  test('allows queries and non-sensitive mutations for an API-key session', () => {
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Query', fieldName: 'me' })).toBe(false)
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName: 'upsertLink' })).toBe(false)
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName: 'deleteItem' })).toBe(false)
  })

  test('does not block cookie sessions or anonymous callers', () => {
    expect(isApiKeyBlocked({ me: { id: 1 }, parentTypeName: 'Mutation', fieldName: 'generateApiKey' })).toBe(false)
    expect(isApiKeyBlocked({ me: null, parentTypeName: 'Mutation', fieldName: 'generateApiKey' })).toBe(false)
  })

  test('set contains the exact sensitive names (guards against typos)', () => {
    for (const name of SENSITIVE) expect(API_KEY_BLOCKED_MUTATIONS.has(name)).toBe(true)
  })
})

describe('apiKeyGuardPlugin', () => {
  function willResolveField ({ me, parentTypeName, fieldName }) {
    const execution = apiKeyGuardPlugin().requestDidStart().executionDidStart()
    return execution.willResolveField({
      contextValue: { me },
      info: { parentType: { name: parentTypeName }, fieldName }
    })
  }

  test('throws for an API-key session on a sensitive mutation', () => {
    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Mutation',
      fieldName: 'generateApiKey'
    })).toThrow(GqlAuthorizationError)
  })

  test('allows cookie sessions, API-key queries, and API-key non-sensitive mutations', () => {
    expect(() => willResolveField({
      me: { id: 1 },
      parentTypeName: 'Mutation',
      fieldName: 'generateApiKey'
    })).not.toThrow()

    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Query',
      fieldName: 'me'
    })).not.toThrow()

    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Mutation',
      fieldName: 'upsertLink'
    })).not.toThrow()
  })
})
