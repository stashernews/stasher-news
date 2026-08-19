// Synchronous-first clipboard copy. document.execCommand('copy') runs inside the
// click's user gesture and writes plain text to the OS clipboard, so it works in
// hardened browsers (e.g. Tor Browser on Whonix) where the async Clipboard API is
// unavailable, throws NotAllowedError, or writes to an isolated clipboard that
// terminal apps (Monero CLI) cannot read. navigator.clipboard.writeText is kept
// as a fallback for browsers that reject execCommand.

function copyExecCommand (text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  let success = false
  try {
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    success = document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
  return success
}

export async function copy (text) {
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    if (copyExecCommand(text)) return
  }
  if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('copy not supported')
}
