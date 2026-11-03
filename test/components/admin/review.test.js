/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { ReviewDialog } from '@/components/admin/review-dialog'

test('review requires a reason and the exact retyped value for every large numeric change', async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(global, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  const container = window.document.getElementById('root')
  const root = createRoot(container)
  const onApply = jest.fn()
  try {
    await act(async () => root.render(<ReviewDialog error='Server rejected the previous attempt' changes={[{ field: { key: 'fee', label: 'Fee', section: 'fees', type: 'xmr' }, expected: '0.001', value: '0.02', jump: true, error: null }]} onApply={onApply} onClose={() => {}} />))
    expect(container.querySelector('[role="alert"]').textContent).toBe('Server rejected the previous attempt')
    const apply = () => container.querySelector('button[type="submit"]')
    expect(apply().disabled).toBe(true)
    const reason = container.querySelector('textarea')
    reason.value = 'Change posting fee'
    await act(async () => reason.dispatchEvent(new window.Event('input', { bubbles: true })))
    expect(apply().disabled).toBe(true)
    const retype = container.querySelector('input')
    retype.value = '0.020'
    await act(async () => retype.dispatchEvent(new window.Event('input', { bubbles: true })))
    expect(apply().disabled).toBe(true)
    retype.value = '0.02'
    await act(async () => retype.dispatchEvent(new window.Event('input', { bubbles: true })))
    expect(apply().disabled).toBe(false)
    await act(async () => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    expect(onApply).toHaveBeenCalledWith([{ key: 'fee', expected: '0.001', value: '0.02', confirmedJump: true }], 'Change posting fee')
    let active = window.document.body
    Object.defineProperty(window.document, 'activeElement', { configurable: true, get: () => active })
    const first = container.querySelector('[role="dialog"] button')
    first.focus = () => { active = first }
    const tab = new window.Event('keydown', { bubbles: true, cancelable: true })
    tab.key = 'Tab'
    window.document.dispatchEvent(tab)
    expect(active === first).toBe(true)
  } finally {
    await act(async () => root.unmount())
    Object.assign(global, old)
  }
})
