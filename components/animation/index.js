import { useCallback, useEffect, useState } from 'react'
import { useMe } from '@/components/me'
import { randInRange } from '@/lib/rand'
import { readGlitchAnimated, readGlitchEnabled, writeGlitchAnimated, writeGlitchEnabled } from '@/lib/animation'

import { GlitchProvider, useGlitch } from './glitch'
// import { SnowProvider, useSnow } from './snow'

const [SelectedAnimationProvider, useSelectedAnimation] = [
  GlitchProvider, useGlitch
  // SnowProvider, useSnow // TODO: the snow animation doesn't seem to work anymore
]

export function AnimationProvider ({ children }) {
  return (
    <SelectedAnimationProvider>
      <AnimationHooks>
        {children}
      </AnimationHooks>
    </SelectedAnimationProvider>
  )
}

export function useAnimation () {
  const animate = useSelectedAnimation()

  return useCallback(() => {
    const should = readGlitchEnabled(window.localStorage)
    if (should !== 'yes') return false
    animate()
    return true
  }, [animate])
}

export function useAnimationEnabled () {
  const [enabled, setEnabled] = useState(undefined)

  useEffect(() => {
    const enabled = readGlitchEnabled(window.localStorage) === 'yes'
    setEnabled(enabled)
  }, [])

  const toggleEnabled = useCallback(() => {
    setEnabled(enabled => {
      const newEnabled = !enabled
      writeGlitchEnabled(window.localStorage, newEnabled)
      return newEnabled
    })
  }, [])

  return [enabled, toggleEnabled]
}

function AnimationHooks ({ children }) {
  const { me } = useMe()
  const animate = useAnimation()

  useEffect(() => {
    if (me || window.localStorage.getItem('striked') || readGlitchAnimated(window.localStorage)) return

    const timeout = setTimeout(() => {
      const animated = animate()
      if (animated) {
        writeGlitchAnimated(window.localStorage, 'yep')
      }
    }, randInRange(3000, 10000))
    return () => clearTimeout(timeout)
  }, [me?.id, animate])

  return children
}
