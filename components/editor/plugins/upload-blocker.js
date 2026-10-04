import { useEffect } from 'react'
import {
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  PASTE_COMMAND
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useToast } from '@/components/toast'
import { SN_UPLOAD_FILES_COMMAND } from '@/lib/lexical/commands/upload'

const UPLOADS_DISABLED_MESSAGE = 'Uploads are disabled for addenda. Paste a link or reuse existing media.'

// Distinguishes a file-only clipboard/drag payload from one carrying real
// text/HTML/URL content. Text-bearing pastes fall through to the normal
// rich/markdown paste pipeline (which may legitimately contain remote media
// URLs); only file-only payloads are blocked.
export function hasFiles (transfer) {
  return Array.from(transfer?.items ?? []).some(item => item.kind === 'file') ||
    (transfer?.files?.length ?? 0) > 0
}

export function hasText (transfer) {
  return Boolean(
    transfer?.getData('text/plain')?.trim() ||
    transfer?.getData('text/html')?.trim() ||
    transfer?.getData('text/uri-list')?.trim()
  )
}

// Registration for the post-window addendum editor (2026-10-04 spec): new
// Stasher file uploads are disabled — picker, clipboard files, drops, and the
// upload shortcut — while links, embeds, and existing media URLs keep working.
// The full FileUploadPlugin is unmounted in this mode, so there is no upload
// pipeline or fee query behind these handlers. Priorities mirror the upload
// plugin's so the blocker fully replaces it.
export function registerUploadBlocker (editor, { toastWarning }) {
  const warn = () => toastWarning?.(UPLOADS_DISABLED_MESSAGE)

  return mergeRegister(
    editor.registerCommand(
      SN_UPLOAD_FILES_COMMAND,
      () => {
        warn()
        // consume: the upload shortcut must not fall through to a browser action
        return true
      },
      COMMAND_PRIORITY_EDITOR
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      (e) => {
        if (!hasFiles(e.clipboardData)) return false
        if (hasText(e.clipboardData)) return false
        e.preventDefault()
        warn()
        return true
      },
      COMMAND_PRIORITY_CRITICAL
    ),
    editor.registerCommand(
      DRAGOVER_COMMAND,
      (e) => {
        // prevent the browser's file-navigation default without showing the
        // upload dragOver affordance; text drags keep normal handling
        if (!hasFiles(e.dataTransfer)) return false
        e.preventDefault()
        return true
      },
      COMMAND_PRIORITY_HIGH
    ),
    editor.registerCommand(
      DROP_COMMAND,
      (e) => {
        if (!hasFiles(e.dataTransfer)) return false
        e.preventDefault()
        warn()
        return true
      },
      COMMAND_PRIORITY_HIGH
    )
  )
}

export default function UploadBlockerPlugin () {
  const [editor] = useLexicalComposerContext()
  const toaster = useToast()

  useEffect(() => registerUploadBlocker(editor, {
    toastWarning: message => toaster?.warning(message)
  }), [editor, toaster])

  return null
}
