import { USER_ID } from '@/lib/constants'
import { payOutCustodialTokenFromBolt11 } from './payOutCustodialTokens'
import { isP2POnly } from './is'

export async function payInReplacePayOuts (models, payInFailedInitial) {
  // payOutBolt11 functionality removed - Monero integration pending
  throw new Error('Monero payments not implemented')
}
