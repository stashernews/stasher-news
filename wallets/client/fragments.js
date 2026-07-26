// Wallet fragments stubs - Monero integration pending (Phase 3+)

import { gql } from '@apollo/client'

export const CREATE_WALLET_INVOICE = gql`
  mutation createWalletInvoice($walletId: ID!, $amount: Int!) {
    createWalletInvoice(walletId: $walletId, amount: $amount) {
      id
    }
  }
`

export const WALLET_SETTINGS = gql`
  fragment WalletSettings on User {
    id
  }
`

export const SET_WALLET_SETTINGS = gql`
  mutation setWalletSettings($settings: WalletSettingsInput!) {
    setWalletSettings(settings: $settings) {
      id
    }
  }
`