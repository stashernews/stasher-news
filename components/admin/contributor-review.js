import { useCallback, useState } from 'react'
import ContributorEligibility from './contributor-eligibility'
import ContributorDisqualified from './contributor-disqualified'
import ContributorSnapshots from './contributor-snapshots'

export default function ContributorReview ({ client, refreshRevision = 0, onCommitted, disabled, onActivityChange }) {
  const [selectedPostId, setSelectedPostId] = useState(null)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [listRevision, setListRevision] = useState(0)
  const [active, setActive] = useState(false)
  const activity = useCallback(value => { setActive(value); onActivityChange?.(value) }, [onActivityChange])
  const select = id => { if (!active) { setSelectedPostId(id); setSelectionRevision(v => v + 1) } }
  // Reload the flagged list before the dashboard refresh, so a failed refresh
  // still leaves the list current.
  const committed = async () => { setListRevision(v => v + 1); await onCommitted?.() }
  return (
    <>
      <ContributorEligibility client={client} selectedPostId={selectedPostId} selectionRevision={selectionRevision} onCommitted={committed} disabled={disabled} onActivityChange={activity} />
      <ContributorDisqualified client={client} onSelectPost={select} revision={`${refreshRevision}:${listRevision}`} disabled={disabled || active} />
      <ContributorSnapshots client={client} onSelectPost={select} revision={refreshRevision} disabled={disabled || active} />
    </>
  )
}
