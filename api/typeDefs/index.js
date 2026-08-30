import { gql } from 'graphql-tag'

import user from './user'
import message from './message'
import item from './item'
import notifications from './notifications'
import invite from './invite'
import sub from './sub'
import upload from './upload'
import growth from './growth'
import rewards from './rewards'
import referrals from './referrals'
import price from './price'
import admin from './admin'
import blockHeight from './blockHeight'
import domain from './domain'
import payIn from './payIn'
import monero from './monero'
import rewardsWallet from './rewardsWallet'
import bounty from './bounty'
import phrase from './phrase'

const common = gql`
  type Query {
    _: Boolean
  }

  type Mutation {
    _: Boolean
  }

  type Subscription {
    _: Boolean
  }

  scalar JSONObject
  scalar Date
  scalar Limit
  scalar BigInt
`

export default [common, user, item, message, notifications, invite,
  sub, upload, growth, rewards, referrals, price, admin, blockHeight, domain, payIn, monero, rewardsWallet, bounty, phrase]
