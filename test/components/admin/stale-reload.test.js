/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { AdminPanel } from '@/components/admin/panel'

function dashboard (fee = '0.001') {
  const field = (key, type, value, min, max, section) => ({ key, type, value, min, max, section, group: 'Settings', label: key, help: 'Test setting', takesEffect: 'cache', source: 'db', effectiveValue: value, locked: false })
  return {
    adminSections: [
      { id: 'overview', label: 'Overview', kind: 'overview', groups: [], fields: [] },
      { id: 'fees', label: 'Fees & pricing', kind: 'settings', groups: ['Settings'], fields: [field('postingFeeFloorPiconeros', 'xmr', fee, '0.0001', '0.1', 'fees')] },
      { id: 'content', label: 'Content & limits', kind: 'settings', groups: ['Settings'], fields: [field('maxItemTurfs', 'int', '5', '1', '10', 'content')] }
    ],
    adminOverview: { fetchedAt: new Date().toISOString(), health: { stale: true }, treasury: { available: false }, trust: {}, rolloutModes: [], activity: { tips: [] } },
    adminAccess: [],
    adminEnvironment: [],
    adminInviteCodes: [],
    adminAudit: { rows: [], nextCursor: null }
  }
}

test.each([true, false])('real Apollo stale recovery preserves staged input; refresh succeeds=%s', async recoverySucceeds => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(global, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  let queries = 0
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_, options) => {
    const mutation = JSON.parse(options.body).operationName === 'ApplyAdmin'
    if (!mutation && queries > 0 && !recoverySucceeds) throw new Error('tunnel dropped during recovery')
    return new Response(JSON.stringify(mutation
      ? { errors: [{ message: 'Settings changed', extensions: { code: 'STALE_VALUE', keys: ['postingFeeFloorPiconeros'] } }] }
      : { data: dashboard(++queries === 1 ? '0.001' : '0.003') }), { headers: { 'content-type': 'application/json' } })
  })
  const root = createRoot(window.document.getElementById('root'))
  const container = window.document.getElementById('root')
  const click = text => [...container.querySelectorAll('button')].find(button => button.textContent.startsWith(text)).dispatchEvent(new window.Event('click', { bubbles: true }))
  const input = (selector, value) => { const node = container.querySelector(selector); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })) }
  try {
    await act(async () => root.render(<AdminPanel />))
    await act(async () => click('Fees & pricing'))
    await act(async () => input('#field-postingFeeFloorPiconeros', '0.002'))
    await act(async () => click('Content & limits'))
    await act(async () => input('#field-maxItemTurfs', '6'))
    await act(async () => click('Review & apply'))
    await act(async () => input('#apply-reason', 'Test two staged edits'))
    await act(async () => container.querySelector('[role="dialog"] form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    if (recoverySucceeds) {
      expect(container.textContent).toContain('Conflicting edits were cleared; other edits are preserved.')
      expect(container.querySelector('#field-maxItemTurfs').value).toBe('6')
      expect(container.textContent).toContain('1 pending change')
      await act(async () => click('Fees & pricing'))
      expect(container.querySelector('#field-postingFeeFloorPiconeros').value).toBe('0.003')
    } else {
      expect(container.querySelector('[role="dialog"]').textContent).toContain('Could not reload changed values')
      expect(container.textContent).toContain('2 pending changes')
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
    fetch.mockRestore()
    Object.assign(global, old)
  }
})
