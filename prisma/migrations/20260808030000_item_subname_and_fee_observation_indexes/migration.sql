-- CreateIndex
CREATE INDEX "Item_subName_idx" ON "Item"("subName");

-- CreateIndex
CREATE INDEX "FeeObservation_state_confirmedAt_idx" ON "FeeObservation"("state", "confirmedAt");
