-- A-13 Task 6: bounty ranking weight + trigger re-binding.
--
-- The ranking trigger gains the funded bounty amount (Item.bountyPiconeros)
-- wherever the piconeros tip term enters — weight 1:1 with tips per the plan:
--   - ranktop: + bountyPiconeros (1:1, same as piconeros)
--   - litCenteredSum INSERT weight: + bountyPiconeros / 1000.0 (same divisor
--     as the piconeros term in that sum)
--   - litCenteredSum UPDATE-delta weight: + (NEW - OLD) bountyPiconeros / 1000.0
-- Both the INSERT and UPDATE-delta branches mirror the live trigger body
-- (read from pg_proc, 2026-08-13) exactly, with only the bounty terms added.
-- ranklit needs no direct edit: it is computed from litCenteredSum, which now
-- carries the bounty weight.
--
-- Re-binds the trigger with "bountyPiconeros" added to the UPDATE OF column
-- list. Without it the bounty weight would be dead code: the funding CONFIRMED
-- path (driveBountyFunding, pages/api/monero/webhook.js) sets bountyPiconeros
-- in an update that touches no previously-listed column, and Postgres fires an
-- UPDATE trigger only when a listed column is in the SET clause. The extension
-- is purely additive — every update that fired before still fires. Function
-- body and trigger definition (BEFORE, FOR EACH ROW, attribute ordering)
-- otherwise match the live definition verbatim.

BEGIN;

CREATE OR REPLACE FUNCTION item_ranking_trigger() RETURNS trigger AS $trigger$
DECLARE
  w DOUBLE PRECISION;
  old_sum DOUBLE PRECISION;
  old_at DOUBLE PRECISION;
  now_epoch DOUBLE PRECISION := EXTRACT(EPOCH FROM now())::DOUBLE PRECISION;
BEGIN
  -- 1. compute ranktop
  NEW.ranktop := (
    COALESCE(NEW.cost, 0)::double precision * 1000.0
    + COALESCE(NEW.piconeros, 0)::double precision
    + COALESCE(NEW."bountyPiconeros", 0)::double precision
    + COALESCE(NEW.boost, 0)::double precision
    + COALESCE(NEW."commentPiconeros", 0)::double precision * 0.25
    + COALESCE(NEW."commentCost", 0)::double precision * 250.0
    + COALESCE(NEW."commentBoost", 0)::double precision
    - COALESCE(NEW."downPiconeros", 0)::double precision
    - COALESCE(NEW."commentDownPiconeros", 0)::double precision * 0.1
  );

  -- 2. compute lit centered sum weight from field deltas
  IF TG_OP = 'INSERT' THEN
    w := (
      COALESCE(NEW.cost, 0)::double precision
      + COALESCE(NEW.piconeros, 0)::double precision / 1000.0
      + COALESCE(NEW."bountyPiconeros", 0)::double precision / 1000.0
      + COALESCE(NEW.boost, 0)::double precision
      + COALESCE(NEW."commentPiconeros", 0)::double precision * 0.25 / 1000.0
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
      + (COALESCE(NEW.piconeros, 0) - COALESCE(OLD.piconeros, 0))::double precision / 1000.0
      + (COALESCE(NEW."bountyPiconeros", 0) - COALESCE(OLD."bountyPiconeros", 0))::double precision / 1000.0
      + (COALESCE(NEW.boost, 0) - COALESCE(OLD.boost, 0))::double precision
      + (COALESCE(NEW."commentPiconeros", 0) - COALESCE(OLD."commentPiconeros", 0))::double precision * 0.25 / 1000.0
      + (COALESCE(NEW."commentCost", 0) - COALESCE(OLD."commentCost", 0))::double precision * 0.25
      + (COALESCE(NEW."commentBoost", 0) - COALESCE(OLD."commentBoost", 0))::double precision * 0.25
      - (COALESCE(NEW."downPiconeros", 0) - COALESCE(OLD."downPiconeros", 0))::double precision / 1000.0
      - (COALESCE(NEW."commentDownPiconeros", 0) - COALESCE(OLD."commentDownPiconeros", 0))::double precision * 0.1 / 1000.0
    );
    old_sum := OLD."litCenteredSum";
    old_at := OLD."litCenteredAt";
  END IF;

  -- 3. update litCenteredSum via exponential decay centered at litCenteredAt
  --    EXP() arguments are <= 0 by construction (no overflow), but can underflow
  --    when the time gap exceeds ~168 days. GREATEST(..., -700) clamps the exponent
  --    to a safe range (IEEE 754 min ≈ -708); the decayed term is effectively 0.
  IF w <> 0 THEN
    IF now_epoch >= old_at THEN
      -- decay old sum to now, then add w
      NEW."litCenteredSum" := old_sum * EXP(GREATEST(LN(2) * (old_at - now_epoch) / 14400.0, -700.0)) + w;
    ELSE
      -- old_at is in the future: add w scaled by decay from old_at to now
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

-- Re-bind: extend the UPDATE OF column list with "bountyPiconeros" so the
-- funding CONFIRMED update fires the trigger (purely additive extension).
DROP TRIGGER item_ranking ON "Item";
CREATE TRIGGER item_ranking BEFORE INSERT OR UPDATE OF cost, piconeros, boost, "commentPiconeros",
  "commentCost", "commentBoost", "downPiconeros", "commentDownPiconeros", "bountyPiconeros"
  ON "Item" FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();

COMMIT;
