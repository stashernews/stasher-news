/* eslint-env jest */
import { qrImageSettings } from '@/components/qr'

describe('qr center glyph', () => {
  it('uses the monero2 emblem', () => {
    expect(qrImageSettings.src).toContain('data:image/svg+xml')
    expect(qrImageSettings.src).toContain('viewBox')
    expect(qrImageSettings.excavate).toBe(true)
    expect(qrImageSettings.height).toBe(60)
    expect(qrImageSettings.width).toBe(60)
  })
})
