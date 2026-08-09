/* eslint-env jest */
import { qrImageSettingsFor } from '@/components/qr'

describe('qr center glyph', () => {
  it('uses the monero mark when rebrand is on', () => {
    const settings = qrImageSettingsFor(true)
    expect(settings.src).toMatch(/stroke='%23111'/)
    expect(settings.excavate).toBe(true)
    expect(settings.height).toBe(60)
  })

  it('uses the legacy bolt when rebrand is off', () => {
    const settings = qrImageSettingsFor(false)
    expect(settings.src).not.toMatch(/monero/i)
  })
})
