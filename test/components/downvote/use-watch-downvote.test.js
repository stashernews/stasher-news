/* eslint-env jest */
import { downvoteWatchOptions } from '@/components/downvote/use-watch-downvote'

describe('downvoteWatchOptions', () => {
  it('polls network-only so a stale cached PENDING result is never served', () => {
    const opts = downvoteWatchOptions('pid-1')
    expect(opts.fetchPolicy).toBe('network-only')
    expect(opts.nextFetchPolicy).toBe('network-only')
  })

  it('keys the poll by the paymentId the modal holds', () => {
    expect(downvoteWatchOptions('pid-1').variables).toEqual({ paymentId: 'pid-1' })
  })

  it('skips polling until a paymentId exists', () => {
    expect(downvoteWatchOptions(null).skip).toBe(true)
    expect(downvoteWatchOptions('pid-1').skip).toBe(false)
  })
})
