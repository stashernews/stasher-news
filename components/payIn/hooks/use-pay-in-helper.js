import { useApolloClient, useMutation } from '@apollo/client/react'
import { useCallback, useMemo } from 'react'
import { paidWaitFor } from '@/lib/pay-in'
import { GET_PAY_IN_RESULT, RETRY_PAY_IN } from '@/fragments/payIn'
import { FAST_POLL_INTERVAL_MS } from '@/lib/constants'

export default function usePayInHelper () {
  const client = useApolloClient()
  const [retryPayIn] = useMutation(RETRY_PAY_IN)

  const check = useCallback(async (id, that, { query = GET_PAY_IN_RESULT } = {}) => {
    const { data, error } = await client.query({ query, fetchPolicy: 'network-only', variables: { id } })
    if (error) {
      throw error
    }

    return { payIn: data.payIn, check: that(data.payIn) }
  }, [client])

  const waitCheckController = useCallback((payInId) => {
    return waitCheckPayInController(payInId, check)
  }, [check])

  const retry = useCallback(async (payIn, { sendProtocolId, update } = {}) => {
    const { data, error } = await retryPayIn({ variables: { payInId: payIn.id, sendProtocolId }, update })
    if (error) throw error

    const newPayIn = data.retryPayIn

    return newPayIn
  }, [retryPayIn])

  return useMemo(() => ({ retry, check, waitCheckController }), [retry, check, waitCheckController])
}

export class WaitCheckControllerAbortedError extends Error {
  constructor (payInId) {
    super(`waitCheckPayInController: aborted: ${payInId}`)
    this.name = 'WaitCheckControllerAbortedError'
    this.payInId = payInId
  }
}

function waitCheckPayInController (payInId, check) {
  const controller = new AbortController()
  const signal = controller.signal
  controller.wait = async (waitFor = paidWaitFor, options) => {
    console.log('waitCheckPayInController: wait', payInId)
    let result
    return await new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          console.log('waitCheckPayInController: checking', payInId)
          result = await check(payInId, waitFor, options)
          if (result.check) {
            resolve(result.payIn)
            clearInterval(interval)
            signal.removeEventListener('abort', abort)
          } else {
            console.info(`payIn #${payInId}: waiting for payment ...`)
          }
        } catch (err) {
          console.log('waitCheckPayInController: error', payInId, err)
          reject(err)
          clearInterval(interval)
          signal.removeEventListener('abort', abort)
        }
      }, FAST_POLL_INTERVAL_MS)

      const abort = () => {
        console.info(`payIn #${payInId}: stopped waiting`)
        result?.check ? resolve(result.payIn) : reject(new WaitCheckControllerAbortedError(payInId))
        clearInterval(interval)
        signal.removeEventListener('abort', abort)
      }
      signal.addEventListener('abort', abort)
    })
  }

  controller.stop = () => controller.abort()

  return controller
}
