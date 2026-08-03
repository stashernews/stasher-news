// Wallet functionality stubs - Monero integration pending (Phase 3+)
// These hooks are placeholders until Monero wallet implementation

export function WalletsProvider ({ children }) {
  return children
}

export function useWalletPayment () {
  return async () => { throw new Error('Monero payments not implemented') }
}

export function usePreferredSendProtocolId () {
  return null
}

export function useWalletIndicator () {
  return null
}

export function useWalletCapabilities () {
  return { canSend: false, canReceive: false }
}

export function useRouteWallet () {
  return null
}
