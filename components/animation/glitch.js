import React, { useContext } from 'react'
import { shuffleArray } from '@/lib/rand'
import { glitchGhostCount, loudestBands, shouldPlayGlitch } from '@/lib/animation'

export const GlitchContext = React.createContext(() => {})

const BAND_COUNT = 6
const BAND_DURATION_MS = 1200

// Full-screen "slice tear + chromatic aberration" burst (approved C+ v2,
// optimized). Clones #__next into 6 clipped horizontal bands that jitter with
// abrupt steps(1) jumps (VHS tear); the loudest-moving bands carry red and
// teal channel copies (screen-blended, ±10px diagonal) so displacement shows
// chromatic fringes. Inner CSS animations freeze for the burst via the
// injected .glitch-band * rule. All CSS lives in the injected <style>; the
// overlay is built imperatively (same pattern as the old Bolt canvas) and
// removed on animationend with a timeout fallback.
export class GlitchProvider extends React.Component {
  constructor (props) {
    super(props)
    this.overlay = null
    this.pending = false
  }

  glitch = () => {
    if (this.overlay) {
      this.pending = true
      return
    }
    this.start()
  }

  start = () => {
    const domNodeCount = document.querySelectorAll('*').length
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!shouldPlayGlitch({ domNodeCount, reducedMotion, visibilityState: document.visibilityState })) {
      this.pending = false
      return
    }

    const overlay = buildGlitchOverlay({
      root: document.getElementById('__next'),
      ghostCount: glitchGhostCount(domNodeCount),
      onDone: () => {
        this.overlay = null
        if (this.pending) {
          this.pending = false
          this.start()
        }
      }
    })
    if (!overlay) return
    this.overlay = overlay
    overlay.play()
  }

  render () {
    return <GlitchContext.Provider value={this.glitch}>{this.props.children}</GlitchContext.Provider>
  }
}

export const GlitchConsumer = GlitchContext.Consumer

export function useGlitch () {
  return useContext(GlitchContext)
}

const OVERLAY_CSS = `
  .glitch-band {
    position: absolute; inset: 0; will-change: transform;
    contain: layout paint; overflow: hidden; animation: none;
  }
  .glitch-band * { animation-play-state: paused !important; transition: none !important; }
  .glitch-band .chan-off { position: absolute; inset: 0; }
  .glitch-band.chan-r {
    filter: sepia(1) hue-rotate(-32deg) saturate(6) brightness(1);
    mix-blend-mode: screen;
  }
  .glitch-band.chan-t {
    filter: sepia(1) hue-rotate(140deg) saturate(6) brightness(1);
    mix-blend-mode: screen;
  }
  .glitch-band.chan-r .chan-off { transform: translate(-10px, 3px); }
  .glitch-band.chan-t .chan-off { transform: translate(10px, -3px); }
  .glitch-band.chan-r, .glitch-band.chan-t { opacity: 0; }
  .glitch-band.chan-r, .glitch-band.chan-t { animation-play-state: running !important; }
  .glitch-band.run.s1 { animation: s1 .9s steps(1) both; }
  .glitch-band.run.s2 { animation: s2 .9s steps(1) both; }
  .glitch-band.run.s3 { animation: s3 .9s steps(1) both; }
  .glitch-band.run.s4 { animation: s4 .9s steps(1) both; }
  .glitch-band.run.s5 { animation: s5 .9s steps(1) both; }
  .glitch-band.run.s6 { animation: s6 .9s steps(1) both; }
  .glitch-band.run.chan-r.s1, .glitch-band.run.chan-t.s1 { animation: s1 .9s steps(1) both, c1 .9s steps(1) both; }
  .glitch-band.run.chan-r.s2, .glitch-band.run.chan-t.s2 { animation: s2 .9s steps(1) both, c1 .9s steps(1) both; }
  .glitch-band.run.chan-r.s3, .glitch-band.run.chan-t.s3 { animation: s3 .9s steps(1) both, c1 .9s steps(1) both; }
  .glitch-band.run.chan-r.s4, .glitch-band.run.chan-t.s4 { animation: s4 .9s steps(1) both, c1 .9s steps(1) both; }
  .glitch-band.run.chan-r.s5, .glitch-band.run.chan-t.s5 { animation: s5 .9s steps(1) both, c1 .9s steps(1) both; }
  .glitch-band.run.chan-r.s6, .glitch-band.run.chan-t.s6 { animation: s6 .9s steps(1) both, c1 .9s steps(1) both; }
  @keyframes c1 {
    0% { opacity: 0; }
    15% { opacity: .92; }
    30% { opacity: 0; }
    45% { opacity: .78; }
    60% { opacity: 0; }
    100% { opacity: 0; }
  }
  @keyframes s1 { 0% { transform: translateX(0); } 16% { transform: translateX(-26px); } 34% { transform: translateX(12px); } 52% { transform: translateX(0); } 100% { transform: translateX(0); } }
  @keyframes s2 { 0% { transform: translateX(0); } 20% { transform: translateX(30px); } 38% { transform: translateX(-14px); } 56% { transform: translateX(0); } 100% { transform: translateX(0); } }
  @keyframes s3 { 0% { transform: translateX(0); } 14% { transform: translateX(-18px); } 40% { transform: translateX(22px); } 58% { transform: translateX(0); } 100% { transform: translateX(0); } }
  @keyframes s4 { 0% { transform: translateX(0); } 22% { transform: translateX(24px); } 42% { transform: translateX(-20px); } 60% { transform: translateX(0); } 100% { transform: translateX(0); } }
  @keyframes s5 { 0% { transform: translateX(0); } 18% { transform: translateX(-32px); } 36% { transform: translateX(16px); } 54% { transform: translateX(0); } 100% { transform: translateX(0); } }
  @keyframes s6 { 0% { transform: translateX(0); } 24% { transform: translateX(22px); } 44% { transform: translateX(-10px); } 62% { transform: translateX(0); } 100% { transform: translateX(0); } }
`

function positionedClone (root, scrollY) {
  const clone = root.cloneNode(true)
  clone.style.position = 'absolute'
  clone.style.top = '0'
  clone.style.left = '0'
  clone.style.width = '100%'
  clone.style.transform = `translateY(${-scrollY}px)`
  return clone
}

function buildGlitchOverlay ({ root, ghostCount = 2, onDone }) {
  if (!root) return null

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;overflow:hidden;will-change:transform;contain:layout;'

  const style = document.createElement('style')
  style.textContent = OVERLAY_CSS
  overlay.appendChild(style)

  const scrollY = window.scrollY
  // Shuffle which band plays which keyframe so every burst looks different;
  // ghosts ride the two loudest keyframes (loudestBands) wherever they land.
  const keyframeOrder = shuffleArray([0, 1, 2, 3, 4, 5])
  const ghosts = new Set(loudestBands().slice(0, ghostCount))

  const bandHeight = 100 / BAND_COUNT
  const bands = keyframeOrder.map((kfIndex, i) => {
    const clip = `inset(${(i * bandHeight).toFixed(3)}% 0 ${(100 - (i + 1) * bandHeight).toFixed(3)}% 0)`
    const delay = `${(i % 3) * 0.02}s`
    const band = document.createElement('div')
    band.className = `glitch-band s${kfIndex + 1}`
    band.style.clipPath = clip
    band.style.animationDelay = delay
    band.appendChild(positionedClone(root, scrollY))
    if (ghosts.has(kfIndex)) {
      for (const chan of ['chan-r', 'chan-t']) {
        const copy = document.createElement('div')
        copy.className = `glitch-band ${chan} s${kfIndex + 1}`
        copy.style.clipPath = clip
        copy.style.animationDelay = delay
        const off = document.createElement('div')
        off.className = 'chan-off'
        off.appendChild(positionedClone(root, scrollY))
        copy.appendChild(off)
        band.appendChild(copy)
      }
    }
    return band
  })

  bands.forEach(band => overlay.appendChild(band))
  document.body.appendChild(overlay)

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    document.removeEventListener('visibilitychange', onVisibility)
    clearTimeout(fallback)
    overlay.remove()
    onDone?.()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') remove()
  }
  document.addEventListener('visibilitychange', onVisibility)

  const fallback = setTimeout(remove, BAND_DURATION_MS)
  bands[bands.length - 1].addEventListener('animationend', () => remove())

  return {
    overlay,
    play: () => {
      if (removed) return
      const allBands = overlay.querySelectorAll('.glitch-band')
      allBands.forEach(band => {
        band.classList.remove('run')
        void band.offsetWidth // eslint-disable-line no-void
        band.classList.add('run')
      })
    }
  }
}
