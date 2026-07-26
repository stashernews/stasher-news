// Wallet error stubs - Monero integration pending (Phase 3+)

export class WalletError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WalletError'
  }
}

export class WalletConfigurationError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WalletConfigurationError'
  }
}

export class WalletSendStateNotReadyError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WalletSendStateNotReadyError'
  }
}

export class WalletPaymentError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WalletPaymentError'
  }
}

export class WalletPaymentAggregateError extends Error {
  constructor (errors) {
    super('Multiple wallet errors')
    this.errors = errors
    this.name = 'WalletPaymentAggregateError'
  }
}

export class InvoiceCanceledError extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvoiceCanceledError'
  }
}

export class InvoiceExpiredError extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvoiceExpiredError'
  }
}

export class WalletReceiverError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WalletReceiverError'
  }
}

export class AnonWalletError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AnonWalletError'
  }
}

export function toastPayError (toaster, error) {
  toaster?.danger?.(error?.message || 'Payment error')
}

export function isTransientNetworkError (e) {
  return false
}

export function throwUnlessUserCancel (error) {
  // User cancellation is handled gracefully
  if (error?.name === 'UserCanceledError') return
  if (error) throw error
}
