/* eslint-env jest */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ItemInfo from '@/components/item-info'
import { RepostModal } from '@/components/repost'

let settings
let viewer
jest.mock('../../components/editor', () => ({ SNEditor: 'textarea' }))
jest.mock('@apollo/client/react', () => ({ useQuery: () => ({ data: { siteSettings: settings, activeSubs: [] } }) }))
jest.mock('../../components/me', () => ({ useMe: () => ({ me: viewer }) }))
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn() }) }))
jest.mock('../../components/root', () => ({ useRoot: () => null }))
jest.mock('../../components/territory-branding', () => ({ useBranding: () => null }))
jest.mock('../../components/use-can-edit', () => () => [false, jest.fn(), null, 'NONE'])
jest.mock('../../components/modal', () => ({ useShowModal: () => jest.fn() }))
jest.mock('../../components/toast', () => ({ useToast: () => ({}) }))
jest.mock('../../components/action-dropdown', () => ({ children }) => children)
jest.mock('../../components/payIn/hooks/use-pay-in-mutation', () => () => [jest.fn()])
jest.mock('../../components/repost-fee-modal', () => () => null)
jest.mock('../../components/pending-fee-badge', () => () => null)
jest.mock('../../components/pay-posting-fee-button', () => () => null)
jest.mock('../../components/bounty-funding-view', () => () => null)
jest.mock('../../components/delete', () => ({ DeleteDropdownItem: () => null }))
jest.mock('../../components/dont-link-this', () => () => null)
jest.mock('../../components/bookmark', () => () => null)
jest.mock('../../components/subscribe', () => () => null)
jest.mock('../../components/share', () => ({ CopyLinkDropdownItem: () => null, CrosspostDropdownItem: () => null }))
jest.mock('../../components/badge', () => () => null)
jest.mock('../../components/mute', () => () => null)
jest.mock('../../components/upvote', () => ({ DropdownItemUpVote: () => null }))
jest.mock('../../components/territory-header', () => ({ MuteSubDropdownItem: () => null, PinSubDropdownItem: () => null }))
jest.mock('../../components/user-popover', () => ({ children }) => children)
jest.mock('../../components/sub-popover', () => ({ children }) => children)
jest.mock('react-bootstrap/Dropdown', () => {
  const React = require('react')
  const Item = ({ children }) => React.createElement('div', null, children)
  return { __esModule: true, default: { Item } }
})
jest.mock('react-bootstrap/Badge', () => {
  const React = require('react')
  return { __esModule: true, default: ({ children }) => React.createElement('span', null, children) }
})

const item = {
  id: '1',
  path: '1',
  user: { id: 7, name: 'author' },
  mine: true,
  createdAt: new Date().toISOString(),
  subNames: ['one', 'two', 'three', 'four', 'five'],
  upvotes: 0,
  piconeros: 0,
  cost: 0,
  boost: 0,
  ncomments: 0,
  commentPiconeros: 0,
  commentCost: 0,
  commentBoost: 0
}

beforeEach(() => {
  settings = { maxItemTurfs: 5, defaultPostsFilterPiconeros: -25000000000, defaultCommentsFilterPiconeros: -25000000000 }
  viewer = { id: 7, privates: {} }
})

test('item-info repost eligibility follows a changed public turf cap', () => {
  expect(renderToStaticMarkup(<ItemInfo item={item} />)).not.toContain('repost to another turf')
  settings = { ...settings, maxItemTurfs: 6 }
  expect(renderToStaticMarkup(<ItemInfo item={item} />)).toContain('repost to another turf')
})

test('item-info investment badge follows the public post filter for anonymous viewers', () => {
  viewer = null
  const downvoted = { ...item, mine: false, netInvestment: -1, downPiconeros: 1000000000 }
  expect(renderToStaticMarkup(<ItemInfo item={downvoted} showActionDropdown={false} />)).not.toContain('role="button"')
  settings = { ...settings, defaultPostsFilterPiconeros: 0 }
  expect(renderToStaticMarkup(<ItemInfo item={downvoted} showActionDropdown={false} />)).toContain('role="button"')
})

test('repost empty-state copy uses the live cap', () => {
  settings = { ...settings, maxItemTurfs: 8 }
  expect(renderToStaticMarkup(<RepostModal item={item} onClose={() => {}} />)).toContain('8 max')
})
