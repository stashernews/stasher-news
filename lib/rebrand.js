import { SSR } from '@/lib/constants'

// Single source of truth for the visual-identity rebrand flag.
// Set NEXT_PUBLIC_STASHER_REBRAND=true in the environment to enable.
// When false/unset the site renders exactly as the pre-rebrand UI.
export const REBRAND_ENABLED = process.env.NEXT_PUBLIC_STASHER_REBRAND === 'true'

// Hook form for use inside React components. The value is build-time
// inlined (NEXT_PUBLIC_*), so it is stable per deploy — no context needed.
export function useRebrand () {
  return REBRAND_ENABLED
}

// Server-side helper for _document.js (runs on the server where the raw
// env var is also available, so we read it directly to avoid any
// tree-shaking surprises during SSR).
export function rebrandClass () {
  const on = SSR ? process.env.NEXT_PUBLIC_STASHER_REBRAND === 'true' : REBRAND_ENABLED
  return on ? 'stealth-rebrand' : ''
}

// Font family name for display glyphs (close-X, EMPTY/end markers, headings).
// When the rebrand is on we use the Google Fonts 'Chakra Petch' family (loaded
// under that exact name via the stylesheet link in _document.js); when off, the
// legacy Alarm Clock font (still registered under the 'lightning' family name).
export const DISPLAY_FONT = REBRAND_ENABLED ? 'Chakra Petch' : 'lightning'
