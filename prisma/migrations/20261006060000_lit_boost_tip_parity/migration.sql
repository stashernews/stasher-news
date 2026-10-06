-- Hot-feed boost weight parity (rank-lit): boosts now scale exactly like tips.
--
-- item_ranking_trigger's ranktop branch (the "top" sort) has been exact 1:1
-- between tips and boosts since A-14 (20260810010000): both are piconeros at
-- weight 1. The lit branch, however, came out of the A-14 rewrite with the
-- tip terms divided by 1000 (tips enter the decayed litCenteredSum in the
-- same milli-piconero unit the cost terms natively use) while the boost terms
-- stayed at raw piconero weight — the leftover scaling of the original
-- msats-format formula. Net effect since 2026-08-10: per piconero, a boost
-- outweighed a tip 1000:1 in the hot feed (a 1 mXMR boost carried the lit
-- weight of 1 XMR of tips), which contradicts the FAQ's "boosts are exactly
-- like a tip for ranking purposes" promise on the sort surfaced by the lit
-- feeds. This migration scales every boost term in BOTH lit branches by
-- /1000.0, matching its tip-class counterpart:
--
--   ranktop:             tip 1:1 boost            (unchanged in this file)
--   lit INSERT/UPDATE w: tip /1000  ==  boost /1000
--   lit comment terms:   commentTip *0.25/1000 == commentBoost *0.25/1000
--
-- The promo boost credit (Item.promoBoostPiconeros) mirrors the paid boost in
-- every branch, so the corrected scaling applies to both classes at once.
--
-- ranktop is intentionally untouched, and the trigger's UPDATE OF column list
-- is unchanged — no trigger re-registration is needed (CREATE OR REPLACE
-- FUNCTION is atomically visible to the existing item_ranking trigger).
--
-- Historical hot weights are explicitly grandfathered: litCenteredSum mixes
-- past boost and non-boost contributions, so dividing the total by 1000 would
-- also incorrectly rescale tips and costs. This migration fixes new deltas only.
-- Decay/recentering does NOT remove the old ranking advantage: for a positive
-- sum, LN(S * EXP(-k * dt)) + k * (t + dt) = LN(S) + k * t.
-- Old boost contributions therefore retain their inflated coefficient; neither
-- waiting a day nor firing another rank update constitutes a historical repair.
-- The sales TERMS the fix produces are pinned by
-- test/prisma/boost-credit-ranking.test.js (a 500000000 boost enters
-- litCenteredSum as exactly 500000, same as a tip of that amount).

CREATE OR REPLACE FUNCTION item_ranking_trigger() RETURNS trigger AS $trigger$
DECLARE
  w DOUBLE PRECISION;
  old_sum DOUBLE PRECISION;
  old_at DOUBLE PRECISION;
  now_epoch DOUBLE PRECISION := EXTRACT(EPOCH FROM now())::DOUBLE PRECISION;
BEGIN
  -- 1. compute ranktop (capped tip terms) — tips and boosts 1:1, unchanged.
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

  -- 2. compute lit centered sum weight from field deltas (capped tip terms).
  -- The lit sum is denominated in milli-piconeros (the unit cost already
  -- carries); every money-class term is /1000 per piconero, boosts included.
  IF TG_OP = 'INSERT' THEN
    w := (
      COALESCE(NEW.cost, 0)::double precision
      + COALESCE(NEW."tipRankPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW."bountyPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW.boost, 0)::double precision / 1000.0
      + COALESCE(NEW."promoBoostPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW."commentTipRankPiconeros", 0)::double precision * 0.25 / 1000.0
      + COALESCE(NEW."commentCost", 0)::double precision * 0.25
      + COALESCE(NEW."commentBoost", 0)::double precision * 0.25 / 1000.0
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
      + (COALESCE(NEW.boost, 0) - COALESCE(OLD.boost, 0))::double precision / 1000.0
      + (COALESCE(NEW."promoBoostPiconeros", 0) - COALESCE(OLD."promoBoostPiconeros", 0))::double precision / 1000.0
      + (COALESCE(NEW."commentTipRankPiconeros", 0) - COALESCE(OLD."commentTipRankPiconeros", 0))::double precision * 0.25 / 1000.0
      + (COALESCE(NEW."commentCost", 0) - COALESCE(OLD."commentCost", 0))::double precision * 0.25
      + (COALESCE(NEW."commentBoost", 0) - COALESCE(OLD."commentBoost", 0))::double precision * 0.25 / 1000.0
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
