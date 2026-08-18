/* eslint-env jest */
import * as items from '@/fragments/items'
import * as comments from '@/fragments/comments'
import * as users from '@/fragments/users'
import * as subs from '@/fragments/subs'
import * as invites from '@/fragments/invites'
import * as payIn from '@/fragments/payIn'
import * as notifications from '@/fragments/notifications'
import * as rewards from '@/fragments/rewards'
import * as domains from '@/fragments/domains'

// graphql-tag only dedupes same-named fragments whose content is
// byte-identical. Any document that ends up with two same-named fragments with
// different content fails GraphQL validation with "There can be only one
// fragment named X". Regression (2026-08-18): the comments.js StreakFields copy
// diverged (added hasAttachedWallet) and broke 23 documents, including every
// posting mutation. All StreakFields copies now share one definition via
// fragments/streak-fields.js; this invariant guards the whole class.
const modules = { items, comments, users, subs, invites, payIn, notifications, rewards, domains }

function sourceKey (def) {
  return JSON.stringify({ on: def.typeCondition?.name?.value, sel: def.selectionSet })
}

function docs () {
  const out = []
  for (const [modName, mod] of Object.entries(modules)) {
    for (const [key, val] of Object.entries(mod)) {
      if (val && typeof val === 'object' && Array.isArray(val.definitions)) {
        out.push([`${modName}.${key}`, val])
      }
    }
  }
  return out
}

describe('fragment name invariant', () => {
  test('no exported GraphQL document contains two same-named fragments with different content', () => {
    const conflicts = []
    for (const [name, doc] of docs()) {
      const byName = new Map()
      for (const f of doc.definitions) {
        if (f.kind !== 'FragmentDefinition') continue
        if (!byName.has(f.name.value)) byName.set(f.name.value, new Set())
        byName.get(f.name.value).add(sourceKey(f))
      }
      for (const [n, keys] of byName) {
        if (keys.size > 1) conflicts.push(`${name}: fragment "${n}" diverges`)
      }
    }
    expect(conflicts).toEqual([])
  })
})
