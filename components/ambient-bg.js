import { REBRAND_ENABLED } from '@/lib/rebrand'
import LoopVideo from '@/components/loop-video'

// Pure-CSS covert background: radial orange glows + masked grid on near-black.
// Replaces western LoopVideo assets behind the rebrand flag. No network, no
// asset sourcing, always on-theme. With the flag off, src/width/height props
// render the original western LoopVideo and children pass through untouched,
// so pre-rebrand pages are byte-identical.
export default function AmbientBg ({ children, src, width, height, className }) {
  if (!REBRAND_ENABLED) {
    return src
      ? <LoopVideo src={src} width={width} height={height} className={className} />
      : (children ?? null)
  }

  if (children) {
    // page-level fill: spans the content area behind the wrapped card
    return (
      <div className='ambient-bg' style={{ position: 'relative', width: '100%', display: 'flex' }}>
        <div className='ambient-bg__layer' aria-hidden />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }}
        >
          {children}
        </div>
      </div>
    )
  }

  // standalone video-slot replacement: keep the LoopVideo footprint so the
  // flag-on layout matches the flag-off page structure
  return (
    <div
      className='ambient-bg'
      style={{
        position: 'relative',
        width: width ? `${width}px` : undefined,
        maxWidth: '100%',
        aspectRatio: width && height ? `${width} / ${height}` : undefined
      }}
    >
      <div className='ambient-bg__layer' aria-hidden />
    </div>
  )
}
