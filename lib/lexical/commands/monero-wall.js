import { createCommand, COMMAND_PRIORITY_EDITOR, $getSelection, $isRangeSelection } from 'lexical'
import { MONERO_WALL_MARKER } from '@/lib/monero-wall'
import { isMarkdownMode } from '@/lib/lexical/commands/utils'
import { MD_FORMAT_COMMAND } from '@/lib/lexical/commands/formatting/markdown'

export const SN_INSERT_MONEROWALL_COMMAND = createCommand('SN_INSERT_MONEROWALL_COMMAND')

// split at the cursor so the marker always lands on its own paragraph and
// the selection ends on the locked side, ready to keep typing. Splitting
// via insertParagraph (instead of $insertNodes) keeps the selection valid
// for non-empty paragraphs too.
function $insertMoneroWallMarker () {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return false
  selection.insertParagraph()
  const markerSelection = $getSelection()
  if (!$isRangeSelection(markerSelection)) return false
  markerSelection.insertText(MONERO_WALL_MARKER)
  const afterMarker = $getSelection()
  if (!$isRangeSelection(afterMarker)) return false
  afterMarker.insertParagraph()
  return true
}

/**
 * registers command to insert the [monerowall] marker
 * rich mode splits at the cursor and inserts a marker paragraph;
 * markdown mode inserts the marker as its own line of text via the
 * markdown format handlers
 * @param {Object} params.editor - lexical editor instance
 * @returns {Function} unregister function
 */
export function registerSNInsertMoneroWallCommand (editor) {
  return editor.registerCommand(SN_INSERT_MONEROWALL_COMMAND, () => {
    if (isMarkdownMode(editor)) {
      return editor.dispatchCommand(MD_FORMAT_COMMAND, 'moneroWall')
    }
    return $insertMoneroWallMarker()
  }, COMMAND_PRIORITY_EDITOR)
}
