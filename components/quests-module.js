import { Fragment } from 'react'
import classNames from 'classnames'
import { useMe } from './me'
import { BadgeTooltip } from './badge'
import { LADDER_COPY, QUEST, TURF_DISCOUNT_PERCENT, questTitle } from '@/lib/quests'

// Daily quests module (spec 2026-09-23-daily-quests). Rendered ONLY on the
// viewer's own profile; visual reference:
// docs/mockups/2026-09-24-quests-round7-ladder.html. Every flame day carries a
// hover/focus tooltip describing that day's ladder reward.
export default function QuestsModule () {
  const { me } = useMe()
  const p = me?.privates
  if (!me || !p) return null

  const cycleDay = p.flameCycleDay || 0
  const gold = p.goldFlame
  const today = cycleDay === 0 ? 1 : cycleDay
  const held = [
    p.freezeHeld && '❄ freeze held',
    p.turfDiscountHeld && `${TURF_DISCOUNT_PERCENT}% turf discount held`
  ].filter(Boolean)

  return (
    <div className='quests-module'>
      <div className='qm-hd'>
        <span className='qm-title'>daily quests</span>
        <span className='qm-timer'>resets in <b>{formatReset(p.questResetsAt)}</b></span>
      </div>

      <div className='qm-q'>
        <span className={classNames('qm-ic', p.questUpvoteComplete && 'on')}><UpArrow /></span>
        <span className='qm-nm'>send an upvote</span>
        <span className={classNames('qm-rw', p.questUpvoteComplete && 'completed')}>
          {p.questUpvoteComplete ? 'Completed!' : 'Reward: +1 reply'}
        </span>
      </div>
      <div className='qm-q'>
        <span className={classNames('qm-ic', p.questDrawnComplete && 'on')}><DrawnIcon type={p.questDrawnType} /></span>
        <span className='qm-nm'>{questTitle(p.questDrawnType, p.questDrawnTurf)}</span>
        <span className={classNames('qm-rw', p.questDrawnComplete && 'completed')}>
          {p.questDrawnComplete ? 'Completed!' : 'Reward: +1 reply'}
        </span>
      </div>

      <div className={classNames('qm-flame', gold && 'gold')}>
        <div className='qm-flab'>flame · {cycleDay === 0 ? 'not started' : `day ${cycleDay}`}</div>
        <div className='qm-days'>
          {DAYS.map((day, i) => (
            <Fragment key={day}>
              {i > 0 && <span className={classNames('qm-conn', day <= cycleDay && 'on')} />}
              <BadgeTooltip overlayText={LADDER_COPY[day]}>
                <span className={classNames('qm-dc', day <= cycleDay && 'on', day === today && 'today')}>
                  <span className={classNames('qm-mk', day <= cycleDay && 'on')}>{MARKERS[day]}</span>
                  <span className='qm-dot'>{day}</span>
                </span>
              </BadgeTooltip>
            </Fragment>
          ))}
        </div>
      </div>

      <BadgeTooltip overlayText={suppliesTooltip(p)}>
        <div className='qm-sup'>
          <b>{p.freeCommentsLeft}</b> {p.freeCommentsLeft === 1 ? 'reply' : 'replies'} · <b>{p.freePostsLeft}</b> {p.freePostsLeft === 1 ? 'post' : 'posts'} · {p.freePostCredits} banked {p.freePostCredits === 1 ? 'post' : 'posts'}
          {held.length > 0 && <span className='qm-hl'> · {held.join(' · ')}</span>}
        </div>
      </BadgeTooltip>
    </div>
  )
}

const DAYS = [1, 2, 3, 4, 5, 6, 7]

const Doc = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><rect x='2' y='1' width='8' height='10' rx='1' /><path d='M4 4h4M4 6h4' /></svg>
)
const Flame = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M6 1.2C7.4 3.4 9.2 4.6 9.2 7a3.2 3.2 0 0 1-6.4 0C2.8 5.6 3.9 4.6 4.7 3.7c.3 1 .8 1.6 1.4 2C6.2 4.5 6.2 2.6 6 1.2Z' /></svg>
)
const Snowflake = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'><path d='M6 1v10M1.9 3.5l8.2 5M10.1 3.5l-8.2 5' /></svg>
)

const MARKERS = { 1: <Flame />, 2: <Doc />, 3: '+1', 4: <Snowflake />, 5: <Flame />, 6: <Doc />, 7: '%' }

const UpArrow = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M12 4l8 10h-5v6H9v-6H4z' /></svg>
)
const BoostIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M5 16c4 1 8-1 9-5l1-3 3 1-1 3c-1 4-6 7-12 7z' /><path d='M13 5l1 3' /></svg>
)
const FirstResponderIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M4 5h16v11H9l-5 4z' /><path d='M12 8.2l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z' fill='currentColor' stroke='none' /></svg>
)
const TurfIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M6 3v18M6 4h11l-2.5 4L17 12H6z' /></svg>
)

function DrawnIcon ({ type }) {
  if (type === QUEST.BOOST) return <BoostIcon />
  if (type === QUEST.FIRST_RESPONDER) return <FirstResponderIcon />
  return <TurfIcon />
}

function suppliesTooltip (p) {
  return [
    `${p.freeCommentsLeft} free ${p.freeCommentsLeft === 1 ? 'reply' : 'replies'} left today`,
    `${p.freePostsLeft} free ${p.freePostsLeft === 1 ? 'post' : 'posts'} left this month`,
    p.freePostCredits > 0 &&
      `${p.freePostCredits} banked ${p.freePostCredits === 1 ? 'post' : 'posts'} from your flame — used after the monthly ones`
  ].filter(Boolean).join(' · ')
}

function formatReset (resetsAt) {
  const ms = new Date(resetsAt).getTime() - Date.now()
  const h = Math.max(0, Math.floor(ms / 3_600_000))
  const m = Math.max(0, Math.floor((ms % 3_600_000) / 60_000))
  return `${h}h ${m}m`
}
