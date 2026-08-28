/* eslint-env jest */
import { maskEmail } from '../crypto'

describe('maskEmail', () => {
  test('shows first char of local part and full domain', () => {
    expect(maskEmail({ email: 'john.doe@gmail.com' })).toBe('j***@gmail.com')
  })

  test('keeps single-char local part recognizable', () => {
    expect(maskEmail({ email: 'a@b.co' })).toBe('a***@b.co')
  })

  test('preserves case exactly as entered', () => {
    expect(maskEmail({ email: 'John@Gmail.com' })).toBe('J***@Gmail.com')
  })

  test('masks only the local part, subdomains included', () => {
    expect(maskEmail({ email: 'ghost@mail.example.com' })).toBe('g***@mail.example.com')
  })

  test('degrades gracefully on a missing domain', () => {
    expect(maskEmail({ email: 'localpart' })).toBe('l***@')
  })
})
