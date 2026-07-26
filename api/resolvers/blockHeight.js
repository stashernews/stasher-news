import { isServiceEnabled } from '@/lib/sndev'

export default {
  Query: {
    blockHeight: async () => {
      if (!isServiceEnabled('payments')) return 0
      throw new Error('Monero payments are not implemented until Phase 2')
    }
  }
}
