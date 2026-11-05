import classNames from 'classnames'
import { FLAME_TIERS, flameTierVars } from '@/lib/flame-tiers'

// The same two paths as svgs/flame.svg, drawn as layers so a level can paint them.
const OUTER = 'M24.555,25.1 C23.0016934,30.9449043 17.3352812,34.7152461 11.3440153,33.8903819 C5.35274935,33.0655178 0.916028269,27.9041991 1,21.857 C0.976535234,20.8605193 1.14107319,19.868542 1.485,18.933 C2.643,11.595 9.785,11.063 5.8,7.1e-15 C5.8,7.1e-15 12.45,1.727 13.8,12.143 C13.8,12.143 18.719,11.98 15.4,4.857 C20.6710017,8.24748606 24.1823552,13.7862803 25,20 C25.0272045,21.7107711 24.8780839,23.4197933 24.555,25.1 Z'
const CORE = 'M20,26.5 C19.9377343,30.5021395 16.7437199,33.7501147 12.743185,33.8794141 C8.74265019,34.0087135 5.34556836,30.9737661 5.025,26.984 L5,27 C5,27 4.925,23.728 5,23 C5.684,16.389 7.6,13.437 10,9 C10.067,6.361 8.885,16.273 15,19 C18.0165975,20.2750836 19.9832296,23.2250317 20,26.5 Z'
const OFFSET = 'translate(-1 0)'
const VIEW_BOX = '-5 0 34 34'

const TipArc1 = () => <path d='M5.2 1.2 L7.6 4.6 L8.4 1.8 L11 5.8 L11.8 3.2 L14.2 5.2' />
const TipArc2 = () => <path d='M5 1 L6.4 -1.8 L8.6 .2 L10.6 -1.4 L12 1.6 L14.4 4.6' />

const SideArcs1 = () => (
  <>
    <path d='M15.5 5.5 L20.5 7.5 L18.8 10 L24.4 12.2 L22.6 15.2 L28 17.4 L25.6 20.6' />
    <path d='M24.4 12.2 L27.8 11.2' />
    <path d='M2.2 14.5 L-2.4 17 L.4 19.2 L-4 22.4 L-.8 24.6 L-3.6 28.2 L1.6 29.6' />
    <path d='M5 .6 L2 3.4 L4 4.8 L.8 7.6' />
  </>
)
const SideArcs2 = () => (
  <>
    <path d='M24.6 19 L28.4 21.4 L25.8 23.8 L29 27 L25.4 28.6 L26.6 32.4 L21.6 31.6' />
    <path d='M25.8 23.8 L22.8 25' />
    <path d='M6 6.5 L1.6 6 L3.2 9.4 L-1.8 10.4 L.6 13.4 L-3.6 15.6 L-.4 17.6' />
    <path d='M13 1.2 L16 2.6 L14.4 4.4 L17.8 5.2' />
  </>
)

const flamelet = (x, y) => `M${x} ${y} c.6 2.4 3 3.6 3 6.4 a3 3 0 0 1 -6 0 c0 -1.6 1 -2.4 1.6 -3.4 c.2 .8 .5 1.2 .9 1.4 c.1 -1.4 .2 -2.8 .5 -4.4 z`
const RISING = [flamelet(5.5, 5), flamelet(14, 4), flamelet(20.5, 9)]

const Layer = ({ className, children }) => <svg className={className} viewBox={VIEW_BOX}>{children}</svg>

const Body = ({ className }) => (
  <Layer className={classNames('fl-b', className)}>
    <g transform={OFFSET}><path className='o' d={OUTER} /><path className='c' d={CORE} /></g>
  </Layer>
)

// Depth over the fills: lit tips and a darker base. Sits above the colour layers
// so a flash, flood or changeover stays shaded, and below the arcs and sparks.
const Shade = () => <Layer className='fl-sh'><path transform={OFFSET} d={OUTER} fill='url(#flame-shade)' /></Layer>

function Layers ({ look }) {
  if (look === 'prism') return <Body />
  if (look === 'tip') {
    return (
      <>
        <Body />
        <Shade />
        <Layer className='fl-a a1'><TipArc1 /></Layer>
        <Layer className='fl-a a2'><TipArc2 /></Layer>
      </>
    )
  }
  if (look === 'surge') {
    return (
      <>
        <Body />
        <Layer className='fl-s'><g clipPath='url(#flame-clip)'><polygon points='-6 40 30 34 30 78 -6 84' /></g></Layer>
        <Shade />
        {RISING.map((d, i) => <Layer key={i} className={`fl-p p${i + 1}`}><path d={d} /></Layer>)}
      </>
    )
  }
  return (
    <>
      <Body />
      <Body className='fl-2' />
      <Layer className='fl-k'><path transform={OFFSET} d={CORE} /></Layer>
      <Shade />
      <Layer className='fl-a a1'><SideArcs1 /></Layer>
      <Layer className='fl-a a2'><SideArcs2 /></Layer>
    </>
  )
}

/**
 * A level 2 flame. `quiet` holds it still until hovered, for surfaces that show
 * many at once; the top tier always moves. Sizing follows the icon convention
 * (`height`) so it can stand in for the plain flame in a badge. Returns null for
 * a tier with no look.
 */
export default function FlameLevel ({ tier, height = 16, quiet = false, label }) {
  const vars = flameTierVars(tier)
  if (!vars) return null
  const { look } = FLAME_TIERS[tier]
  const style = { ...vars, '--s': `${height}px`, '--sw': `${Math.max(1, height / 52).toFixed(2)}px` }
  return (
    <span
      className={classNames('flame-level', look, quiet && 'quiet', height >= 32 && 'glow')}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Layers look={look} />
    </span>
  )
}

/** The shared gradient and clip every level refers to, mounted once. Zero-size
 * rather than display: none, which would break those references. */
export function FlameLevelDefs () {
  return (
    <svg width='0' height='0' style={{ position: 'absolute' }} aria-hidden='true'>
      <defs>
        <linearGradient id='flame-prism' x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor='#ff2d55' />
          <stop offset='.2' stopColor='#ffb300' />
          <stop offset='.4' stopColor='#3dff6e' />
          <stop offset='.6' stopColor='#19c8ff' />
          <stop offset='.8' stopColor='#5a4dff' />
          <stop offset='1' stopColor='#ff2dd1' />
        </linearGradient>
        <linearGradient id='flame-shade' x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stopColor='#fff' stopOpacity='.42' />
          <stop offset='.45' stopColor='#fff' stopOpacity='0' />
          <stop offset='.62' stopColor='#000' stopOpacity='0' />
          <stop offset='1' stopColor='#000' stopOpacity='.42' />
        </linearGradient>
        <clipPath id='flame-clip'><path transform={OFFSET} d={OUTER} /></clipPath>
      </defs>
    </svg>
  )
}
