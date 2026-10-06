import { Fragment, useEffect, useState } from 'react'
import classNames from 'classnames'
import { useMe } from './me'
import { BadgeTooltip } from './badge'
import { ladderCopyFor, QUEST, QUEST_REPLY_REWARDS, questTitle } from '@/lib/quests'

// Daily quests module (spec 2026-09-23-daily-quests). Rendered ONLY on the
// viewer's own profile; visual reference:
// docs/mockups/2026-09-24-quests-round7-ladder.html. Every flame day carries a
// hover/focus tooltip describing that day's ladder reward.
export default function QuestsModule () {
  const { me } = useMe()
  const p = me?.privates
  if (!me || !p) return null

  // The card shows the current cycle: the day being worked (until today's quests
  // are cleared), its week, and only the circles earned in this cycle.
  const day = p.flameCycleDay || 0
  const week = p.flameWeek || 1
  const gold = p.goldFlame
  const todayCleared = !!(p.questUpvoteComplete && p.questDrawnComplete)
  const litThrough = todayCleared ? day : day - 1
  const today = day === 0 ? 1 : day
  // The turf discount is surfaced in the turf form's billing (and the day-7
  // tooltip); the card only calls out the shield, which is invisible elsewhere.
  const shield = p.goldFlame
  const held = [shield && 'flame shield active'].filter(Boolean)
  const boostCredit = p.boostCreditId != null

  return (
    <div className='quests-module'>
      <div className='qm-hd'>
        <span className='qm-title'>daily ops</span>
        <span className='qm-timer'>resets in <ResetTimer resetsAt={p.questResetsAt} /></span>
      </div>

      <div className='qm-q'>
        <span className={classNames('qm-ic', p.questUpvoteComplete && 'on')}><UpArrow /></span>
        <span className='qm-nm'>send an upvote</span>
        <span className={classNames('qm-rw', p.questUpvoteComplete && 'completed')}>
          {p.questUpvoteComplete ? 'Completed!' : `Reward: ${replyReward(QUEST_REPLY_REWARDS[QUEST.UPVOTE])}`}
        </span>
      </div>
      <div className='qm-q'>
        <span className={classNames('qm-ic', p.questDrawnComplete && 'on')}><DrawnIcon type={p.questDrawnType} /></span>
        <span className='qm-nm'>{questTitle(p.questDrawnType)}</span>
        <span className={classNames('qm-rw', p.questDrawnComplete && 'completed')}>
          {p.questDrawnComplete ? 'Completed!' : `Reward: ${replyReward(QUEST_REPLY_REWARDS[p.questDrawnType] ?? 1)}`}
        </span>
      </div>

      <div className={classNames('qm-flame', gold && 'gold')}>
        <BadgeTooltip overlayText='the flame is earned by completing your daily ops. keep it alive to earn a perk every day.'>
          <div className='qm-flab'><b>flame</b> · {day === 0 ? 'not started' : `day ${day}, week ${week}`}</div>
        </BadgeTooltip>
        <div className='qm-days'>
          {DAYS.map((day, i) => (
            <Fragment key={day}>
              {i > 0 && <span className={classNames('qm-conn', day <= litThrough && 'on')} />}
              <BadgeTooltip overlayText={ladderCopyFor(day, week)}>
                <span className={classNames('qm-dc', day <= litThrough && 'on', day === today && 'today')}>
                  <span className={classNames('qm-mk', day <= litThrough && 'on')}>{markersFor(week)[day]}</span>
                  <span className='qm-dot'>{day}</span>
                </span>
              </BadgeTooltip>
            </Fragment>
          ))}
        </div>
      </div>

      <BadgeTooltip overlayText={<SuppliesTooltip p={p} />}>
        <div className='qm-sup'>
          <b>{p.freeCommentsLeft}</b> {p.freeCommentsLeft === 1 ? 'reply' : 'replies'} · <b>{p.freePostsLeft}</b> {p.freePostsLeft === 1 ? 'post' : 'posts'}
          {boostCredit && <> · <b>1</b> boost</>}
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
const Chat = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M1.5 2.5h9v5.5h-4L4 10.5V8H1.5z' /></svg>
)
const Flame = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M6 1.2C7.4 3.4 9.2 4.6 9.2 7a3.2 3.2 0 0 1-6.4 0C2.8 5.6 3.9 4.6 4.7 3.7c.3 1 .8 1.6 1.4 2C6.2 4.5 6.2 2.6 6 1.2Z' /></svg>
)
// Day 5 (odd weeks) / day 2 (even weeks) is the boost-credit rung: same
// double-chevron as the platform's boost glyph (BoostIcon /
// svgs/arrow-up-double-line.svg), redrawn at marker scale — markers are
// stroke-only (styles/stealth-theme.scss forces fill:none).
const Boost = () => (
  <svg viewBox='0 0 12 12' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M2.5 6.75L6 3.25l3.5 3.5M2.5 10.5L6 7l3.5 3.5' /></svg>
)
// Week-parity markers, mirroring the ladder sets in lib/quests: even weeks
// move the boost chevron to day 2, the post glyph to day 5, and a reply glyph
// to day 6.
const MARKERS_ODD = { 1: <Chat />, 2: <Doc />, 3: <Chat />, 4: <Flame />, 5: <Boost />, 6: <Doc />, 7: '%' }
const MARKERS_EVEN = { 1: <Chat />, 2: <Boost />, 3: <Chat />, 4: <Flame />, 5: <Doc />, 6: <Chat />, 7: '%' }

/** The seven ladder markers for a 1-based flame week (odd weeks keep the
 * original set; even weeks swap the day-2/5/6 glyphs). */
export function markersFor (week) {
  return week % 2 === 1 ? MARKERS_ODD : MARKERS_EVEN
}

// Rev 4: every reward rung reads as an icon; the reward label derives from
// the shared map so card, bell and push can never disagree.
const replyReward = n => `+${n} ${n === 1 ? 'reply' : 'replies'}`

const UpArrow = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M12 4l8 10h-5v6H9v-6H4z' /></svg>
)
const BoostIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M5 12l7-7 7 7M5 19l7-7 7 7' /></svg>
)
const FirstResponderIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M4 5h16v11H9l-5 4z' /><path d='M12 8.2l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z' fill='currentColor' stroke='none' /></svg>
)
const ComposeIcon = () => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round'><path d='M12 20h9' /><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' /></svg>
)

function DrawnIcon ({ type }) {
  if (type === QUEST.BOOST) return <BoostIcon />
  if (type === QUEST.FIRST_RESPONDER) return <FirstResponderIcon />
  return <ComposeIcon />
}

function suppliesTooltip (p) {
  // One line per section, each its own sentence; rendered with <br/> so long
  // supplies tooltips stay readable.
  return [
    `${p.freeCommentsLeft} free ${p.freeCommentsLeft === 1 ? 'reply' : 'replies'} left today` +
      (p.freeReplyCredits > 0 ? `, ${p.freeReplyCredits} banked from your flame` : '') + '.',
    `${p.freePostsLeft} free ${p.freePostsLeft === 1 ? 'post' : 'posts'} left this month` +
      (p.freePostCredits > 0 ? `, ${p.freePostCredits} banked from your flame` : '') + '.',
    p.boostCreditId != null && '1 boost credit.',
    p.goldFlame && 'your golden flame absorbs a missed day, keeping your streak alive.'
  ].filter(Boolean)
}

function SuppliesTooltip ({ p }) {
  return (
    <>
      {suppliesTooltip(p).map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </>
  )
}

function formatReset (resetsAt) {
  const ms = new Date(resetsAt).getTime() - Date.now()
  const h = Math.max(0, Math.floor(ms / 3_600_000))
  const m = Math.max(0, Math.floor((ms % 3_600_000) / 60_000))
  return `${h}h ${m}m`
}

function ResetTimer ({ resetsAt }) {
  // the duration is relative to the clock that renders it, so server and
  // client legitimately disagree (aged SSR HTML, slow loads), so suppress the
  // hydration warning and tick after mount so the countdown converges to the
  // client's truth. Same approach as CountdownShared in components/countdown.js.
  const [label, setLabel] = useState(() => formatReset(resetsAt))
  useEffect(() => {
    setLabel(formatReset(resetsAt))
    const id = setInterval(() => setLabel(formatReset(resetsAt)), 30_000)
    return () => clearInterval(id)
  }, [resetsAt])
  return <b suppressHydrationWarning>{label}</b>
}
