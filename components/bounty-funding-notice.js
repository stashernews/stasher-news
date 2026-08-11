import Alert from 'react-bootstrap/Alert'

const PRE_FUNDING_STATUSES = ['UNFUNDED', 'PENDING_FUNDING', 'DETECTED']

export default function BountyFundingNotice ({ item }) {
  if (!item?.mine || Number(item.bountyPiconeros) <= 0 || !PRE_FUNDING_STATUSES.includes(item.bountyStatus)) {
    return null
  }

  return (
    <Alert variant='warning'>
      Until the funding payment is sent and confirmed, your bounty is only visible to you; once confirmed, it appears in the feeds for other stashers.
    </Alert>
  )
}
