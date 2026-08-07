-- Rename the PayIn linkage column to match the renamed observation table
-- (no coins are burned; downvotes accrue to the rewards wallet).
ALTER TABLE "PayIn" RENAME COLUMN "observedBurnId" TO "observedDownvoteId";
