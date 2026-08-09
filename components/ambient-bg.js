// Pure-CSS covert background: radial orange glows + masked grid on near-black.
// No network, no asset sourcing. A page-level fill when children are given
// (auth pages wrap their card), or a standalone slot sized by width/height
// (error/email/offline pages).
export default function AmbientBg ({ children, width, height }) {
  if (children) {
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
