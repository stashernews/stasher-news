-- Rename the downvote-ledger table to match its purpose (no coins are burned;
-- downvotes accrue to the rewards wallet). Rows are preserved.
ALTER TABLE "ObservedBurn" RENAME TO "ObservedDownvote";

-- Constraints: Postgres does NOT auto-rename constraints on table rename.
-- Prisma doesn't track constraint names, so rename them manually for drift-free
-- future diffs. (PK rename also renames its backing index.)
ALTER TABLE "ObservedDownvote" RENAME CONSTRAINT "ObservedBurn_pkey" TO "ObservedDownvote_pkey";
ALTER TABLE "ObservedDownvote" RENAME CONSTRAINT "ObservedBurn_postId_fkey" TO "ObservedDownvote_postId_fkey";

-- Indexes (Postgres does NOT auto-rename indexes on table rename either).
ALTER INDEX "ObservedBurn_postId_idx" RENAME TO "ObservedDownvote_postId_idx";
ALTER INDEX "ObservedBurn_state_confirmedAt_idx" RENAME TO "ObservedDownvote_state_confirmedAt_idx";
ALTER INDEX "ObservedBurn_txHash_paymentId_key" RENAME TO "ObservedDownvote_txHash_paymentId_key";
