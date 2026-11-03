/* eslint-env jest */
import { renderToStaticMarkup } from 'react-dom/server'
import MyDocument from '@/pages/_document'
import { getDomainBranding } from '@/lib/domains'

jest.mock('next/document', () => {
  const { Component } = require('react')
  class Document extends Component {
    static async getInitialProps () { return {} }
  }
  return { __esModule: true, default: Document, Html: 'html', Head: 'head', Main: 'main', NextScript: 'script' }
})
jest.mock('../../../lib/domains', () => ({ getDomainBranding: jest.fn(async () => null) }))

test('private documents skip public branding and PWA resources without broadening the listener allowlist', async () => {
  const props = await MyDocument.getInitialProps({ pathname: '/admin', req: { headers: { host: 'custom.example' } }, res: { getHeaders: () => ({}) }, renderPage: () => ({}) })
  expect(getDomainBranding).not.toHaveBeenCalled()
  const html = renderToStaticMarkup(<MyDocument {...props} />)
  expect(html).not.toContain('/api/site.webmanifest')
  expect(html).not.toContain('/splash/')
  expect(html).toContain('rel="icon" href="/icons/icon_x192.png"')
})
