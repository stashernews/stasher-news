import LinkIcon from '@/svgs/link.svg'
import ChatIcon from '@/svgs/chat-3-fill.svg'
import PollIcon from '@/svgs/bar-chart-horizontal-fill.svg'
import BountyIcon from '@/svgs/hand-coin-fill.svg'
import JobIcon from '@/svgs/briefcase-4-fill.svg'
import { subNames, subsAllSupport } from '@/lib/subs'
import styles from '@/styles/post-type-switcher.module.css'

export const POST_TYPES = [
  { type: 'link', label: 'link', Icon: LinkIcon },
  { type: 'discussion', label: 'discussion', Icon: ChatIcon },
  { type: 'poll', label: 'poll', Icon: PollIcon },
  { type: 'bounty', label: 'bounty', Icon: BountyIcon },
  { type: 'job', label: 'job', Icon: JobIcon }
]

/**
 * Whether the page's turf scope accepts a post type. Unscoped /post accepts
 * every type but job, which lives only in ~jobs.
 * @param {string} type - lowercase post type
 * @param {Array} subs - the page's sub objects
 * @returns {boolean}
 */
export function turfAllowsType (type, subs) {
  if (type === 'job') return subNames(subs).includes('jobs')
  if (!subs?.length) return true
  return subsAllSupport(subs, type.toUpperCase())
}

// Every type is always visible. A type the current turf doesn't accept stays
// clickable but reads muted: choosing it leaves the turf (see PostForm).
export default function PostTypeSwitcher ({ value, subs, onSelect }) {
  const turf = subNames(subs).join(', ~')

  return (
    <div className={styles.switcher} role='radiogroup' aria-label='post type'>
      {POST_TYPES.map(({ type, label, Icon }) => {
        const active = type === value
        const allowed = turfAllowsType(type, subs)
        return (
          <button
            key={type}
            type='button'
            role='radio'
            aria-checked={active}
            className={`${styles.option} ${active ? styles.active : ''} ${allowed ? '' : styles.elsewhere}`}
            title={allowed ? undefined : type === 'job' ? 'jobs are posted in ~jobs' : `~${turf} doesn't take ${label}s, so this switches turf`}
            onClick={() => !active && onSelect(type)}
          >
            <Icon className={styles.icon} width={16} height={16} aria-hidden='true' />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
