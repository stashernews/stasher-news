import Link from 'next/link'
import { piconerosToMXmr } from '@/lib/format'
import { contributorSectionModel } from '@/lib/contributorPoolCopy'

function ItemLink ({ item }) {
  return (
    <Link href={`/items/${item.id}`} className='text-reset'>
      {item.title || `post ${item.id}`}
    </Link>
  )
}

// Contributor rewards on /rewards. Hidden when the mode is OFF.
export default function ContributorRewards ({ pool }) {
  const model = contributorSectionModel(pool)
  if (!model) return null

  return (
    <div className='my-3 text-center'>
      <h5 className='text-muted'>Contributor rewards</h5>
      <p className='text-muted mb-1'>{model.intro}</p>
      <p className='text-muted'>
        <small>
          <Link href='/faq#how-do-contributor-rewards-work' className='text-info'>how contributor rewards work</Link>
        </small>
      </p>
      {model.candidates.length > 0 && (
        <div className='mb-2'>
          <small className='text-muted d-block'>{model.candidatesTitle}</small>
          <ol className='list-unstyled mb-0'>
            {model.candidates.map(c => (
              <li key={c.item.id}><small>#{c.rank} <ItemLink item={c.item} /></small></li>
            ))}
          </ol>
        </div>
      )}
      {model.resultsTitle && model.results.length > 0 && (
        <div>
          <small className='text-muted d-block'>{model.resultsTitle}</small>
          <ol className='list-unstyled mb-0'>
            {model.results.map(r => (
              <li key={r.item.id}>
                <small>#{r.rank} <ItemLink item={r.item} /> · {piconerosToMXmr(BigInt(r.piconeros), 1)}</small>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
