import { useCallback, useEffect, useRef, useState } from 'react'
import { quote as quoteMd } from '@/lib/md'
import { getMarkdownFromSelection } from '@/lib/lexical/utils/selection'

export function useQuoteReply ({ text, readerRef, additionalReaderRefs = [] }) {
  const ref = useRef(null)
  const [quote, setQuote] = useState(null)
  const [selection, setSelection] = useState(null)
  const to = useRef(null)

  const onSelectionChange = useCallback(e => {
    clearTimeout(to.current)
    const domSelection = window.getSelection()
    const selectedText = domSelection.isCollapsed ? undefined : domSelection.toString()
    const isSelectedTextInTarget = ref?.current?.contains(domSelection.anchorNode)

    if ((domSelection.isCollapsed || !isSelectedTextInTarget || !selectedText)) {
      to.current = setTimeout(() => {
        setSelection(null)
      }, 1000)
      return
    }

    setSelection(selectedText)
  }, [ref?.current, setSelection])

  useEffect(() => {
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [onSelectionChange])

  const quoteReply = useCallback(({ selectionOnly }) => {
    if (selectionOnly && !selection) return
    let textToQuote = selection || text

    if (selection && readerRef) {
      // quote from whichever reader root (original body or addendum) contains
      // the selection — never mix an unrelated original selection into an
      // addendum quote or vice versa
      const domSelection = window.getSelection()
      const containingReader = [readerRef, ...additionalReaderRefs]
        .find(r => r?.current?.contains?.(domSelection?.anchorNode))
      if (containingReader) {
        const markdown = getMarkdownFromSelection(containingReader.current)
        if (markdown) {
          textToQuote = markdown
        }
      }
    }

    setQuote(quoteMd(textToQuote))
  }, [selection, text, readerRef, ...additionalReaderRefs])

  const cancelQuote = useCallback(() => {
    setQuote(null)
    setSelection(null)
  }, [setQuote, setSelection])

  return { ref, quote, quoteReply, cancelQuote }
}
