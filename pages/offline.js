import { StaticLayout } from '@/components/layout'
import styles from '@/styles/error.module.css'
import { DISPLAY_FONT } from '@/lib/rebrand'

export default function offline () {
  return (
    <StaticLayout>
      <h1 className={styles.status} style={{ fontFamily: DISPLAY_FONT }}><span>Offline</span></h1>
    </StaticLayout>
  )
}
