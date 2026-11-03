/* eslint-env jest */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import useCanEdit from '@/components/use-can-edit'

let settings
jest.mock('@apollo/client/react', () => ({ useQuery: () => ({ data: { siteSettings: settings } }) }))
jest.mock('../../components/me', () => ({ useMe: () => ({ me: { id: 7 } }) }))

function Probe ({ item }) {
  const [, , , mode] = useCanEdit(item)
  return <span>{mode}</span>
}

test('edit hook follows the server query instead of a 600-second client mirror', () => {
  const item = { userId: 7, createdAt: new Date(Date.now() - 700000), payIn: { payInState: 'PAID' } }
  settings = { itemEditSeconds: 600 }
  expect(renderToStaticMarkup(<Probe item={item} />)).toBe('<span>ADDENDUM</span>')
  settings = { itemEditSeconds: 1200 }
  expect(renderToStaticMarkup(<Probe item={item} />)).toBe('<span>FULL</span>')
})
