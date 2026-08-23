-- Tip-ranking devaluation (spec §4.4-4.5): the ranking trigger reads the
-- CAPPED tip terms (tipRankPiconeros / commentTipRankPiconeros) instead of the
-- raw totals, and every item's capped terms are backfilled once from
-- ItemUserAgg + the anon residual. No historical un-crediting: displayed
-- totals (piconeros/commentPiconeros) are untouched; over-cap and anon
-- excess simply stop counting.
--
-- ORDER IS LOAD-BEARING: the trigger rewrite runs FIRST. Postgres fires an
-- UPDATE OF trigger only when a listed column is in the SET clause, and the
-- OLD trigger's column list (20260813000000_bounty_ranking) does not include
-- tipRankPiconeros/commentTipRankPiconeros — if the backfill ran before the
-- rewrite, its UPDATEs would fire nothing, ranktop/ranklit would stay
-- computed from the raw piconeros, and self-tip-inflated items would keep
-- their inflated rank indefinitely. With the rewrite first, every backfill
-- UPDATE that changes a rank input (tipRankPiconeros, commentTipRankPiconeros)
-- recomputes ranktop/ranklit per row. The anon-residual statement sets ONLY
-- anonTipPiconeros — deliberately NOT in the trigger's column list — so it
-- correctly fires nothing (it changes no rank input).

BEGIN;

-- 1. Trigger rewrite: swap the two tip terms for the capped terms, extend the
--    UPDATE OF column list. Mirrors 20260813000000_bounty_ranking verbatim
--    except for the term swaps + column list. MUST precede the backfill
--    (see the ordering note above).
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
CREATE TRIGGER item_ranking BEFORE INSERT OR UPDATE OF cost, piconeros, boost, "commentPiconeros",
  "commentCost", "commentBoost", "downPiconeros", "commentDownPiconeros", "bountyPiconeros",
  "tipRankPiconeros", "commentTipRankPiconeros"
  ON "Item" FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();

-- 2. Attributed contributions: sum over each item's tippers of
--    factor(now) x min(their cumulative tips, CAP). factor at backfill time —
--    established tippers count 1.0 (one-time snapshot, like detection time).
UPDATE "Item" i
SET "tipRankPiconeros" = sub.r
FROM (
  SELECT iua."itemId",
         SUM(ROUND(
           (LEAST(iua."tipPiconeros", cfg.cap)::DOUBLE PRECISION * (
             cfg.floor + (1.0 - cfg.floor) * LEAST(1.0, GREATEST(0.0,
               EXTRACT(EPOCH FROM (now() - u."created_at")) / 86400.0 / cfg.ramp
             ))
           ))::NUMERIC
         )::BIGINT) AS r
  FROM "ItemUserAgg" iua
  JOIN users u ON u.id = iua."userId"
  CROSS JOIN (
    SELECT
      COALESCE((SELECT "tipRankCapPiconeros" FROM "PlatformFeeConfig" WHERE id = 1), 100000000000::BIGINT) AS cap,
      COALESCE((SELECT "tipRankFactorFloor" FROM "PlatformFeeConfig" WHERE id = 1), 0.7) AS floor,
      COALESCE((SELECT "tipRankRampDays" FROM "PlatformFeeConfig" WHERE id = 1), 14) AS ramp
  ) cfg
  GROUP BY iua."itemId", cfg.cap, cfg.floor, cfg.ramp
) sub
WHERE sub."itemId" = i.id;

-- 3. Anon residual: piconeros not explained by ItemUserAgg attribution is the
--    collective anon bucket (clamped at 0 for over-attributed rows). Sets
--    ONLY anonTipPiconeros — no rank input, so no trigger fire (intended).
UPDATE "Item" i
SET "anonTipPiconeros" = GREATEST(i.piconeros - COALESCE(attr.total, 0), 0)
FROM (SELECT "itemId", SUM("tipPiconeros") AS total FROM "ItemUserAgg" GROUP BY "itemId") attr
WHERE attr."itemId" = i.id;

UPDATE "Item" i
SET "anonTipPiconeros" = i.piconeros
WHERE NOT EXISTS (SELECT 1 FROM "ItemUserAgg" a WHERE a."itemId" = i.id);

-- 4. Anon contribution: ANON_FACTOR x min(bucket, ANON_CAP).
UPDATE "Item" i
SET "tipRankPiconeros" = i."tipRankPiconeros" + ROUND((cfg.f * LEAST(i."anonTipPiconeros", cfg.acap))::NUMERIC)::BIGINT
FROM (
  SELECT
    COALESCE((SELECT "anonTipRankFactor" FROM "PlatformFeeConfig" WHERE id = 1), 0.7) AS f,
    COALESCE((SELECT "anonTipRankCapPiconeros" FROM "PlatformFeeConfig" WHERE id = 1), 100000000000::BIGINT) AS acap
) cfg
WHERE i."anonTipPiconeros" > 0;

-- 5. Comment propagation: each item's comment term = sum of its descendants'
--    (path containment: d is a descendant of i when i.path @> d.path).
UPDATE "Item" i
SET "commentTipRankPiconeros" = COALESCE((
  SELECT SUM(d."tipRankPiconeros") FROM "Item" d
  WHERE i.path @> d.path AND d.id <> i.id
), 0)
WHERE EXISTS (
  SELECT 1 FROM "Item" d
  WHERE i.path @> d.path AND d.id <> i.id AND d."tipRankPiconeros" > 0
);

COMMIT;
