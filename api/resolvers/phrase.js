// Restored upstream lnurl-auth primitive (api/resolvers/lnurl.js upstream),
// renamed neutrally: this challenge store serves phrase auth now and the
// nostr restoration later. createAuth is the exact mutation the dormant
// components/nostr-auth.js client already calls.
import { randomBytes } from 'node:crypto'
import assertApiKeyNotPermitted from './apiKey'
import { authMethods } from './user'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { verifyChallengeSignature } from '@/lib/recoveryPhrase'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

export const AUTH_CHALLENGE_EXPIRY_MS = 5 * 60_000
export const AUTH_CHALLENGE_SWEEP_MS = 60 * 60_000

export const AUTH_CHALLENGE_IP_LIMIT = Number(process.env.AUTH_CHALLENGE_IP_LIMIT) || 20
export const AUTH_CHALLENGE_IP_WINDOW_MS = Number(process.env.AUTH_CHALLENGE_IP_WINDOW_MS) || 15 * 60_000

export function checkChallengeAllowance ({ headers, socketAddress }) {
  return rateLimit({
    key: `auth-challenge-ip:${clientIp(headers, socketAddress)}`,
    limit: AUTH_CHALLENGE_IP_LIMIT,
    windowMs: AUTH_CHALLENGE_IP_WINDOW_MS
  }).allowed
}

function k1 () {
  return randomBytes(32).toString('hex')
}

// atomically consume a fresh challenge: count 1 = existed + unused + unexpired.
// Race-safe without SELECT FOR UPDATE — concurrent answers, exactly one winner.
export async function consumeChallenge (models, k1Value) {
  const { count } = await models.authChallenge.deleteMany({
    where: { k1: k1Value, createdAt: { gte: new Date(Date.now() - AUTH_CHALLENGE_EXPIRY_MS) } }
  })
  return count === 1
}

export default {
  Mutation: {
    createAuth: async (parent, args, { models, me, headers }) => {
      assertApiKeyNotPermitted({ me })
      if (!checkChallengeAllowance({ headers })) {
        throw new GqlInputError('too many auth challenges requested, slow down')
      }
      // lazy sweep: challenges are single-use and short-lived, no worker needed
      await models.authChallenge.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - AUTH_CHALLENGE_SWEEP_MS) } }
      })
      return await models.authChallenge.create({ data: { k1: k1() } })
    },
    linkPhrase: async (parent, { k1, pubkey, sig }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      assertApiKeyNotPermitted({ me })

      if (!verifyChallengeSignature({ k1, pubkey, sig })) {
        throw new GqlInputError('invalid challenge signature')
      }
      if (!(await consumeChallenge(models, k1))) {
        throw new GqlInputError('challenge expired or already used')
      }

      try {
        const user = await models.user.update({ where: { id: me.id }, data: { phrasePubkey: pubkey } })
        return await authMethods(user, undefined, { models, me })
      } catch (error) {
        if (error.code === 'P2002') {
          throw new GqlInputError('this phrase is already linked to another account')
        }
        throw error
      }
    }
  }
}
