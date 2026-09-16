import { useCallback, useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection, RootNode } from 'lexical'
import { $trimTextContentFromAnchor } from '@lexical/selection'
import { $restoreEditorState } from '@lexical/utils'
import { MAX_POST_TEXT_LENGTH } from '@/lib/constants'
import { getRemainingMarkdown, markdownLength } from '@/lib/lexical/utils'
import { isMarkdownMode } from '@/lib/lexical/commands/utils'
import useDebounceCallback from '@/components/use-debounce-callback'
import { useFeeButton } from '@/components/fee-button'

// fee-button disabled reason published while the submitted markdown exceeds the limit
export const MAX_LENGTH_DISABLED_REASON = 'maxLength'

/**
 * plugin that enforces maximum text length and displays character count
 * the count is the length of the markdown formik submits (the same string the
 * server validates), so write and compose modes report the same unit
 * @param {number} props.lengthOptions.maxLength - maximum character limit
 * @param {boolean} props.lengthOptions.show - whether to always show character count
 * @returns {JSX.Element|null} character count display or null
 */
export function MaxLengthPlugin ({ lengthOptions = {} }) {
  const [editor] = useLexicalComposerContext()
  const { setDisabled } = useFeeButton() ?? {}

  // if no limit is set, MAX_POST_TEXT_LENGTH is used
  // rendering is disabled if not requested
  const { maxLength = MAX_POST_TEXT_LENGTH, show = false } = lengthOptions

  // track remaining characters with state so it updates on editor changes
  const [remaining, setRemaining] = useState(() => {
    return getRemainingMarkdown(editor, maxLength)
  })
  const overLimit = useRef(false)

  useEffect(() => {
    // prevent infinite restoration loops by tracking the last restored editor state
    let lastRestoredEditorState = null

    // run whenever the RootNode (editor content) changes
    return editor.registerNodeTransform(RootNode, (node) => {
      // get the current selection
      const sel = $getSelection()
      // only proceed if we have a range selection that is collapsed (cursor position)
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return

      // get the previous editor state to compare text content size
      const prevEditorState = editor.getEditorState()
      const prevTextContentSize = prevEditorState.read(() => {
        return node.getTextContentSize()
      })

      // get the current text content size
      const textContentSize = node.getTextContentSize()

      // only act if the text content size has changed
      if (prevTextContentSize !== textContentSize) {
        // calculate how many characters need to be deleted if over the limit
        const delCount = textContentSize - maxLength
        const anchor = sel.anchor

        // if we're over the character limit, handle the overflow
        if (delCount > 0) {
          // if the previous state was exactly at the limit and we haven't already restored this state,
          // restore to the previous valid state to prevent going over the limit (infinite loop)
          if (prevTextContentSize === maxLength && lastRestoredEditorState !== prevEditorState) {
            lastRestoredEditorState = prevEditorState
            $restoreEditorState(editor, prevEditorState)
          } else {
            // otherwise, trim the excess characters from the current cursor position
            $trimTextContentFromAnchor(editor, anchor, delCount)
          }
        }
      }
    })
  }, [editor, maxLength])

  const apply = useCallback(() => {
    const length = markdownLength(editor)
    setRemaining(Math.max(0, maxLength - length))
    const over = length > maxLength
    if (over !== overLimit.current) {
      overLimit.current = over
      setDisabled?.(MAX_LENGTH_DISABLED_REASON, over)
    }
  }, [editor, maxLength, setDisabled])

  // rich mode serializes the whole document to markdown, so debounce it like
  // the formik bridge (formik.js) does; markdown mode is a cheap text read
  const debouncedApply = useDebounceCallback(apply, 500, [apply])

  // counter and submit gate measure the exported markdown, not rendered text
  useEffect(() => {
    const onUpdate = ({ dirtyElements, dirtyLeaves }) => {
      // skip non-content updates (cursor moves, etc.)
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return
      if (isMarkdownMode(editor)) {
        apply()
      } else {
        debouncedApply()
      }
    }

    apply()
    return editor.registerUpdateListener(onUpdate)
  }, [editor, apply, debouncedApply])

  // never leave the submit button disabled after unmount
  useEffect(() => {
    return () => setDisabled?.(MAX_LENGTH_DISABLED_REASON, false)
  }, [setDisabled])

  if (show || remaining < 10) {
    return (
      <div className='text-muted form-text'>{remaining} characters remaining</div>
    )
  }

  return null
}
