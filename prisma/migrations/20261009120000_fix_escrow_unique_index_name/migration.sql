-- Align EscrowWalletTransaction's 4-column unique index with Prisma's expected
-- name. The original CREATE INDEX in 20261006120000_payment_transaction_proofs
-- used the explicit name
-- "EscrowWalletTransaction_network_walletAddress_bountyPaymentId_leg_key"
-- (69 chars). Postgres silently truncates identifiers to 63 chars, so the real
-- index was created as
-- "EscrowWalletTransaction_network_walletAddress_bountyPaymentId_l", while
-- Prisma's computed name for @@unique([network, walletAddress, bountyPaymentId,
-- leg]) is the 63-char
-- "EscrowWalletTransaction_network_walletAddress_bountyPayment_key".
-- prisma migrate diff therefore reported a drift (the CI drift check). Rename
-- the index to Prisma's name; the index's columns and uniqueness are unchanged.
ALTER INDEX "EscrowWalletTransaction_network_walletAddress_bountyPaymentId_l"
  RENAME TO "EscrowWalletTransaction_network_walletAddress_bountyPayment_key";
