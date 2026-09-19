-- One tx = one payment id = one receipt row, globally (2026-09-19 review
-- finding): the per-owner unique keys cannot stop a token-holding replay from
-- re-attributing a REAL tx to a different pending pid on the same account
-- (duplicate tip credits, bounty escrow over-commitment, wrong fee-leg flips).
-- The hash-first lookup + pid binding at the verification seam close the claim
-- path; these indexes make the whole class UNREPRESENTABLE at the storage layer.
--
-- Pre-check: fail loudly (before any index DDL) if legacy rows already contain
-- duplicates, so the deploy stops with an actionable message instead of a bare
-- 23505 mid-migration. Operators: inspect the listed tx hashes, keep the
-- earliest/verified row, delete the duplicates, then re-run the deploy.

DO $$
DECLARE
  dup_count integer;
  sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT tx_hash, ', ') INTO dup_count, sample
  FROM (
    SELECT "txHash" AS tx_hash FROM "ObservedTip" GROUP BY "txHash" HAVING count(*) > 1
    UNION ALL
    SELECT "txHash" FROM "ObservedBountyReceipt" GROUP BY "txHash" HAVING count(*) > 1
    UNION ALL
    SELECT tx_hash FROM "ObservedSubFee" GROUP BY tx_hash HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'cannot add global txHash uniques: % duplicate txHash value(s) in receipt tables (e.g. %). Resolve the duplicates, then re-run.', dup_count, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX "ObservedTip_txHash_key" ON "ObservedTip" ("txHash");
CREATE UNIQUE INDEX "ObservedBountyReceipt_txHash_key" ON "ObservedBountyReceipt" ("txHash");
CREATE UNIQUE INDEX "ObservedSubFee_tx_hash_key" ON "ObservedSubFee" (tx_hash);
