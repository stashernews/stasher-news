-- Restore the unique constraint on FeeObservation.payInId so the 1:1 back-relation
-- (PayIn.feeObservation) is valid for Prisma. NULLs remain allowed (multiple NULLs
-- are fine in a Postgres unique index) — wallet-less-tip rows carry payInId = NULL.
CREATE UNIQUE INDEX "FeeObservation_payInId_key" ON "FeeObservation"("payInId");
