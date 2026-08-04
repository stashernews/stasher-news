-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "feeInvestmentPiconeros" BIGINT NOT NULL DEFAULT 0,
ALTER COLUMN "netInvestment" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Sub" ALTER COLUMN "postsPiconerosFilter" SET DEFAULT 1000000000,
ALTER COLUMN "postsPiconerosFilter" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "postsPiconerosFilter" SET DEFAULT 1000000000,
ALTER COLUMN "postsPiconerosFilter" SET DATA TYPE BIGINT,
ALTER COLUMN "commentsPiconerosFilter" SET DEFAULT 0,
ALTER COLUMN "commentsPiconerosFilter" SET DATA TYPE BIGINT;

-- =====================================================================
-- Restore Item.netInvestment maintenance (piconero scale, BigInt).
-- Upstream (6898169a) kept netInvestment via this trigger; the fork's
-- baseline migration omitted it, so netInvestment stayed 0 forever.
-- cost/boost are stored at 1/1000 scale (cost = piconeros/1000) so they are
-- multiplied by 1000 to reach piconeros, matching item_ranking_trigger.
-- feeInvestmentPiconeros carries the posting fee (never tips/boosts).
-- =====================================================================
CREATE OR REPLACE FUNCTION item_net_investment_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."netInvestment" := (
    COALESCE(NEW.cost, 0)::bigint * 1000
    + COALESCE(NEW.boost, 0)::bigint * 1000
    + COALESCE(NEW.piconeros, 0)::bigint
    - COALESCE(NEW."downPiconeros", 0)::bigint
    + COALESCE(NEW."feeInvestmentPiconeros", 0)::bigint
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS item_net_investment ON "Item";
CREATE TRIGGER item_net_investment
  BEFORE INSERT OR UPDATE OF cost, boost, piconeros, "downPiconeros", "feeInvestmentPiconeros"
  ON "Item"
  FOR EACH ROW EXECUTE FUNCTION item_net_investment_trigger();

-- Backfill netInvestment (column was never maintained).
UPDATE "Item" SET "netInvestment" = (
  COALESCE(cost, 0)::bigint * 1000
  + COALESCE(boost, 0)::bigint * 1000
  + COALESCE(piconeros, 0)
  - COALESCE("downPiconeros", 0)
  + COALESCE("feeInvestmentPiconeros", 0)
);

-- Credit the posting fee to already-flipped (FEE_PAID) posts from their
-- observed FeeObservation so they become visible under the new default.
UPDATE "Item" i
SET "feeInvestmentPiconeros" = f."piconeros"
FROM "FeeObservation" f
WHERE f."payInId" = i."feePayInId"
  AND f."feeType" = 'POSTING'
  AND i."feeStatus" = 'FEE_PAID'
  AND i."feeInvestmentPiconeros" = 0;
