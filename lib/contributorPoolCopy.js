// Display model for the contributor rewards section on /rewards. Pure so the wording is testable
// without rendering. Never reads scores: the query does not expose them.

export const CONTRIBUTOR_SHARE_PCT = 15

// null hides the section (OFF, or no data yet).
export function contributorSectionModel (pool) {
  const mode = pool?.mode ?? 'OFF'
  if (mode === 'OFF') return null

  const shadow = mode === 'SHADOW'
  const run = pool.lastRun
  // The last run's own mode decides the label: after a switch to ACTIVE the
  // previous run was still a shadow run.
  const runShadow = run?.mode === 'SHADOW'
  return {
    mode,
    shadow,
    intro: shadow
      ? 'Contributor rewards are in shadow mode: candidates are ranked and recorded, but nothing is paid yet.'
      : `The best original posts of the week share about ${CONTRIBUTOR_SHARE_PCT}% of the weekly curator and contributor budget, paid at Monday's distribution.`,
    candidatesTitle: shadow ? 'Last week’s posts, ranked so far (provisional)' : 'Last week’s posts, ranked so far (provisional, final at Monday 00:00 UTC)',
    candidates: (pool.candidates ?? []).map(c => ({ rank: c.rank, item: c.item })).filter(c => c.item),
    resultsTitle: run ? (runShadow ? 'Would have won last run (nothing paid)' : 'Last run’s winners') : null,
    results: (run?.results ?? []).map(r => ({ rank: r.rank, piconeros: r.piconeros, item: r.item })).filter(r => r.item)
  }
}
