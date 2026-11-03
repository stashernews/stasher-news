// Keep the operator's place across page reloads (a manual refresh, a deploy,
// or a development-server Fast Refresh): the section lives in the URL hash and
// unsaved drafts in this tab's sessionStorage. Restored drafts keep their
// `expected` value, so apply still rejects them if the live value moved.
export const DRAFTS_KEY = 'stasher-admin-drafts'

export function sectionFromHash (hash, sections) {
  const id = String(hash ?? '').replace(/^#/, '')
  return sections.some(section => section.id === id) ? id : null
}

export function readDrafts (storage) {
  try {
    const drafts = JSON.parse(storage?.getItem(DRAFTS_KEY) ?? 'null')
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) return {}
    return Object.fromEntries(Object.entries(drafts).filter(([, draft]) =>
      typeof draft?.expected === 'string' && typeof draft?.value === 'string'))
  } catch {
    return {}
  }
}

export function writeDrafts (storage, drafts) {
  try {
    if (Object.keys(drafts).length) storage?.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    else storage?.removeItem(DRAFTS_KEY)
  } catch {}
}

export function currentHash () {
  try { return window.location?.hash ?? '' } catch { return '' }
}

export function sessionStore () {
  try { return window.sessionStorage ?? null } catch { return null }
}
