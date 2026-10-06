-- Promotional boost ranking storage (spec 2026-10-05-quest-rebalance-boost-credit,
-- task 2): Item.promoBoostPiconeros is the rank-only promo term consumed by
-- BOOST credit redemption. It is NOT money: nothing in the payIn engine, the
-- item_net_investment trigger, or the reward ledger reads it — only
-- item_ranking_trigger folds it into ranktop/ranklit with the same weight as
-- a paid boost.
--
-- The ranking trigger is replaced wholesale with the current live definition
-- from 20260823124834_tip_rank_trigger_backfill (latest rewrite of
-- item_ranking_trigger), with exactly three added terms — ranktop, INSERT w,
-- UPDATE w — and the UPDATE OF column list extended so promo writes fire the
-- trigger (and with it the search index_item trigger's indexItem job).
-- No historical backfill: existing items keep their zero promo term; the
-- add-column DEFAULT 0 is the only seed.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "promoBoostPiconeros" BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION item_ranking_trigger() RETURNS trigger AS $trigger$
DECLARE
  w DOUBLE PRECISION;
  old_sum DOUBLE PRECISION;
  old_at DOUBLE PRECISION;
  now_epoch DOUBLE PRECISION := EXTRACT(EPOCH FROM now())::DOUBLE PRECISION;
BEGIN
  -- 1. compute ranktop (capped tip terms)
  NEW.ranktop := (
    COALESCE(NEW.cost, 0)::double precision * 1000.0
    + COALESCE(NEW."tipRankPiconeros", 0)::double precision
    + COALESCE(NEW."bountyPiconeros", 0)::double precision
    + COALESCE(NEW.boost, 0)::double precision
    + COALESCE(NEW."promoBoostPiconeros", 0)::double precision
    + COALESCE(NEW."commentTipRankPiconeros", 0)::double precision * 0.25
    + COALESCE(NEW."commentCost", 0)::double precision * 250.0
    + COALESCE(NEW."commentBoost", 0)::double precision
    - COALESCE(NEW."downPiconeros", 0)::double precision
    - COALESCE(NEW."commentDownPiconeros", 0)::double precision * 0.1
  );

  -- 2. compute lit centered sum weight from field deltas (capped tip terms)
  IF TG_OP = 'INSERT' THEN
    w := (
      COALESCE(NEW.cost, 0)::double precision
      + COALESCE(NEW."tipRankPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW."bountyPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW.boost, 0)::double precision
      + COALESCE(NEW."promoBoostPiconeros", 0)::double precision
      + COALESCE(NEW."commentTipRankPiconeros", 0)::double precision * 0.25 / 1000.0
      + COALESCE(NEW."commentCost", 0)::double precision * 0.25
      + COALESCE(NEW."commentBoost", 0)::double precision * 0.25
      - COALESCE(NEW."downPiconeros", 0)::double precision / 1000.0
      - COALESCE(NEW."commentDownPiconeros", 0)::double precision * 0.1 / 1000.0
    );
    old_sum := 0;
    old_at := 0;
  ELSE
    w := (
      (COALESCE(NEW.cost, 0) - COALESCE(OLD.cost, 0))::double precision
      + (COALESCE(NEW."tipRankPiconeros", 0) - COALESCE(OLD."tipRankPiconeros", 0))::double precision / 1000.0
      + (COALESCE(NEW."bountyPiconeros", 0) - COALESCE(OLD."bountyPiconeros", 0))::double precision / 1000.0
      + (COALESCE(NEW.boost, 0) - COALESCE(OLD.boost, 0))::double precision
      + (COALESCE(NEW."promoBoostPiconeros", 0) - COALESCE(OLD."promoBoostPiconeros", 0))::double precision
      + (COALESCE(NEW."commentTipRankPiconeros", 0) - COALESCE(OLD."commentTipRankPiconeros", 0))::double precision * 0.25 / 1000.0
      + (COALESCE(NEW."commentCost", 0) - COALESCE(OLD."commentCost", 0))::double precision * 0.25
      + (COALESCE(NEW."commentBoost", 0) - COALESCE(OLD."commentBoost", 0))::double precision * 0.25
      - (COALESCE(NEW."downPiconeros", 0) - COALESCE(OLD."downPiconeros", 0))::double precision / 1000.0
      - (COALESCE(NEW."commentDownPiconeros", 0) - COALESCE(OLD."commentDownPiconeros", 0))::double precision * 0.1 / 1000.0
    );
    old_sum := OLD."litCenteredSum";
    old_at := OLD."litCenteredAt";
  END IF;

  -- 3. update litCenteredSum via exponential decay centered at litCenteredAt
  IF w <> 0 THEN
    IF now_epoch >= old_at THEN
      NEW."litCenteredSum" := old_sum * EXP(GREATEST(LN(2) * (old_at - now_epoch) / 14400.0, -700.0)) + w;
    ELSE
      NEW."litCenteredSum" := old_sum + w * EXP(GREATEST(LN(2) * (now_epoch - old_at) / 14400.0, -700.0));
    END IF;
    NEW."litCenteredAt" := GREATEST(old_at, now_epoch);
  END IF;

  -- 4. compute ranklit sort key
  NEW.ranklit := CASE
    WHEN NEW."litCenteredSum" > 0
      THEN LN(NEW."litCenteredSum") + LN(2) / 14400.0 * NEW."litCenteredAt"
    WHEN NEW."litCenteredSum" < 0
      THEN -(LN(-NEW."litCenteredSum") + LN(2) / 14400.0 * NEW."litCenteredAt")
    ELSE 0
  END;

  RETURN NEW;
END;
$trigger$ LANGUAGE plpgsql;

DROP TRIGGER item_ranking ON "Item";
CREATE TRIGGER item_ranking BEFORE INSERT OR UPDATE OF cost, piconeros, boost,
  "promoBoostPiconeros", "commentPiconeros", "commentCost", "commentBoost",
  "downPiconeros", "commentDownPiconeros", "bountyPiconeros", "tipRankPiconeros",
  "commentTipRankPiconeros"
  ON "Item" FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();
