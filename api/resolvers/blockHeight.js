import { daemonClient } from '@/api/monero/daemonClient'

export default {
  Query: {
    // monerod chain height via the restricted-RPC daemon client. monerod is an
    // opt-in service; when it isn't running we return 0 so the nav carousel
    // hides the height mode (mirrors the try/catch in api/monero/rewards.js).
    blockHeight: async () => {
      try {
        return await daemonClient.getHeight()
      } catch {
        return 0
      }
    }
  }
}
