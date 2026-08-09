import { QRCodeSVG } from 'qrcode.react'
import CopyChip from '@/components/copy-chip'
import Clipboard from '@/svgs/clipboard-line.svg'

const MONERO2_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath fill='%23000' d='M 16 3 C 8.832 3 3 8.832 3 16 C 3 23.168 8.832 29 16 29 C 23.168 29 29 23.168 29 16 C 29 8.832 23.168 3 16 3 z M 16 5 C 22.065 5 27 9.935 27 16 C 27 17.040896 26.843748 18.044906 26.572266 19 L 22 19 L 22 10.976562 L 16 17.261719 L 10 10.976562 L 10 19 L 5.4277344 19 C 5.1562523 18.044906 5 17.040896 5 16 C 5 9.935 9.935 5 16 5 z M 12 15.96875 L 16 20.15625 L 20 15.96875 L 20 21 L 25.785156 21 C 23.960333 24.555852 20.263678 27 16 27 C 11.736322 27 8.0396672 24.555852 6.2148438 21 L 12 21 L 12 15.96875 z'/%3E%3C/svg%3E"

export const qrImageSettings = {
  src: MONERO2_DATA_URI,
  x: undefined,
  y: undefined,
  height: 60,
  width: 60,
  excavate: true
}

export default function Qr ({ value, qrTransform = (value) => value, description, copy = true }) {
  const qrValue = qrTransform(value)

  return (
    <>
      <a className='d-block p-3 mx-auto' style={{ background: 'white', maxWidth: '300px' }} href={qrValue}>
        <QRCodeSVG
          className='h-auto mw-100' value={qrValue} size={300} imageSettings={qrImageSettings}
        />
      </a>
      {description && <div className='mt-1 text-center text-muted'>{description}</div>}
      {copy &&
        <div className='my-2 w-100'>
          <CopyChip value={value} prefix={<Clipboard height={16} width={16} />} full />
        </div>}
    </>
  )
}

export function QrSkeleton ({ description, copy = true }) {
  return (
    <>
      <div className='h-auto mx-auto w-100 clouds' style={{ paddingTop: 'min(300px, 100%)', maxWidth: 'calc(300px)' }} />
      {description && <div className='mt-1 fst-italic text-center text-muted invisible'>i'm invisible</div>}
      {copy &&
        <div className='my-3 w-100'>
          <div className='clouds mx-auto' style={{ height: '40px', width: '100%', borderRadius: '999px' }} />
        </div>}
    </>
  )
}
