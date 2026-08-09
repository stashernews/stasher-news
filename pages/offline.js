import AmbientBg from '@/components/ambient-bg'
import { StaticLayout } from '@/components/layout'
import styles from '@/styles/error.module.css'
import { DISPLAY_FONT, REBRAND_ENABLED } from '@/lib/rebrand'

export default function offline () {
  return (
    <StaticLayout>
      <AmbientBg src={`${process.env.NEXT_PUBLIC_ASSET_PREFIX}/sleeping.mp4`} width='498' height='292' />
      <h1 className={styles.status} style={{ fontFamily: REBRAND_ENABLED ? DISPLAY_FONT : undefined }}><span>Offline</span></h1>
    </StaticLayout>
  )
}
