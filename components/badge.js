import { Fragment } from 'react'
import OverlayTrigger from 'react-bootstrap/OverlayTrigger'
import Tooltip from 'react-bootstrap/Tooltip'
import FlameIcon from '@/svgs/flame.svg'
import VerifiedIcon from '@/svgs/verified.svg'
import AnonIcon from '@/svgs/spy-fill.svg'
import BotIcon from '@/svgs/robot-2-fill.svg'
import { numWithUnits } from '@/lib/format'
import { USER_ID } from '@/lib/constants'
import classNames from 'classnames'

export default function Badges ({ user, badge, bot, className = 'ms-1', badgeClassName, spacingClassName = 'ms-1', height = 16, width = 16 }) {
  if (!user) return null
  if (Number(user.id) === USER_ID.anon) {
    return (
      <BadgeTooltip overlayText='anonymous'>
        <span className={className}><AnonIcon className={`${badgeClassName} align-middle`} height={height} width={width} /></span>
      </BadgeTooltip>
    )
  }

  const badges = buildBadges(user, { bot })

  if (!badges || badges.length === 0) return null

  return (
    <span className={classNames(className, 'd-inline-flex align-items-center justify-content-center')}>
      {badges.map(({ icon, overlayText, sizeDelta, style }, i) => (
        <SNBadge
          key={i}
          user={user}
          badge={badge}
          overlayText={overlayText}
          badgeClassName={classNames(badgeClassName, i > 0 && spacingClassName)}
          IconForBadge={icon}
          height={height}
          width={width}
          sizeDelta={sizeDelta}
          style={style}
        />
      ))}
    </span>
  )
}

export function buildBadges (user, { bot = false } = {}) {
  if (!user) return null
  if (Number(user.id) === USER_ID.anon) return null
  const badges = []
  if (user.optional?.hasWallet) {
    badges.push({ icon: VerifiedIcon, overlayText: 'verified (wallet + reputation)', style: { color: 'var(--theme-grey)' } })
  }
  const streak = user.optional?.streak ?? null
  if (streak !== null) {
    const gold = !!user.optional?.goldFlame
    badges.push({
      icon: FlameIcon,
      overlayText: streak
        ? `${numWithUnits(streak, { abbreviate: false, unitSingular: 'day', unitPlural: 'days' })} quest streak${gold ? ', golden flame' : ''}`
        : 'new quest streak',
      style: { color: gold ? 'var(--gold, #ffd166)' : '#ff6e6e' }
    })
  }
  if (bot) {
    return [{ icon: BotIcon, overlayText: 'posted as bot' }]
  }
  return badges.length === 0 ? null : badges
}

function SNBadge ({ user, badge, overlayText, badgeClassName, IconForBadge, height = 16, width = 16, sizeDelta = 0, style }) {
  let Wrapper = Fragment

  if (overlayText) {
    Wrapper = ({ children }) => (
      <BadgeTooltip overlayText={overlayText}>{children}</BadgeTooltip>
    )
  }

  return (
    <Wrapper>
      <span className='d-inline-flex align-items-center justify-content-center' style={style}><IconForBadge className={badgeClassName} height={height + sizeDelta} width={width + sizeDelta} /></span>
    </Wrapper>
  )
}

export function BadgeTooltip ({ children, overlayText, placement }) {
  return (
    <OverlayTrigger
      placement={placement || 'bottom'}
      overlay={
        <Tooltip style={{ position: 'fixed' }}>
          {overlayText}
        </Tooltip>
      }
      trigger={['hover', 'focus']}
    >
      {children}
    </OverlayTrigger>
  )
}
