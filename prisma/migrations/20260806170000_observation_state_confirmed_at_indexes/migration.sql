-- CreateIndex
CREATE INDEX "ObservedBurn_state_confirmedAt_idx" ON "ObservedBurn"("state", "confirmedAt");

-- CreateIndex
CREATE INDEX "ObservedTip_state_confirmedAt_idx" ON "ObservedTip"("state", "confirmedAt");
