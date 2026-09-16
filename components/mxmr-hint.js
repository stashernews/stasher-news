import { useField } from 'formik'
import { piconerosToMXmr, signedXmrToPiconeros } from '@/lib/format'

export function mxmrHintText (value) {
  let piconeros
  try {
    piconeros = signedXmrToPiconeros(String(value))
  } catch {
    return null
  }
  if (piconeros === 0n) return null
  return `= ${piconerosToMXmr(piconeros)}`
}

export default function MXmrHint ({ value }) {
  const text = mxmrHintText(value)
  if (!text) return null
  return <span className='text-muted'>{text}</span>
}

export function MXmrFieldHint ({ name }) {
  const [, meta] = useField(name)
  return <MXmrHint value={meta.value} />
}
