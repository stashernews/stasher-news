-- =====================================================================
-- Bucket B Task 2: rebrand_piconeros
-- Hand-crafted renames (Prisma's non-interactive diff would drop+re-add
-- columns; we RENAME to preserve data).
--
-- Enum value renames use ALTER TYPE ... RENAME VALUE (transaction-safe on
-- PG 16). Dead INVOICE_*/ROUTING_* enum values are KEPT: PG < 17 has no
-- ALTER TYPE ... DROP VALUE, and type-recreation is destructive/risky for
-- zero value (deferred).
-- =====================================================================

-- ------------------------------------------------------------------
-- Enum value renames
-- ------------------------------------------------------------------
ALTER TYPE "PayInType" RENAME VALUE 'ZAP' TO 'TIP';
ALTER TYPE "PayInType" RENAME VALUE 'DOWN_ZAP' TO 'DOWNVOTE';
ALTER TYPE "Status" RENAME VALUE 'NOSATS' TO 'NO_XMR';
ALTER TYPE "PayOutType" RENAME VALUE 'ZAP' TO 'TIP';

-- ------------------------------------------------------------------
-- Column renames (data preserved)
-- ------------------------------------------------------------------
-- users: the Monero pivot already added stackedPiconeros; stackedMsats was
-- its dead duplicate (no code writes it), so it is DROPPED, not renamed.
ALTER TABLE "users" RENAME COLUMN "stackedMcredits" TO "stackedCredits";
ALTER TABLE "users" RENAME COLUMN "noteItemSats" TO "noteItemPiconeros";
ALTER TABLE "users" RENAME COLUMN "noteForwardedSats" TO "noteForwardedPiconeros";
ALTER TABLE "users" RENAME COLUMN "hideInvoiceDesc" TO "hideUriDesc";
ALTER TABLE "users" RENAME COLUMN "postsSatsFilter" TO "postsPiconerosFilter";
ALTER TABLE "users" RENAME COLUMN "commentsSatsFilter" TO "commentsPiconerosFilter";
ALTER TABLE "users" RENAME COLUMN "zapUndos" TO "tipUndos";
ALTER TABLE "users" DROP COLUMN "stackedMsats";

ALTER TABLE "Item" RENAME COLUMN "msats" TO "piconeros";
ALTER TABLE "Item" RENAME COLUMN "downMsats" TO "downPiconeros";
ALTER TABLE "Item" RENAME COLUMN "commentMsats" TO "commentPiconeros";
ALTER TABLE "Item" RENAME COLUMN "commentDownMsats" TO "commentDownPiconeros";
ALTER TABLE "Item" RENAME COLUMN "lastZapAt" TO "lastTipAt";
ALTER TABLE "Item" RENAME COLUMN "mcredits" TO "credits";
ALTER TABLE "Item" RENAME COLUMN "commentMcredits" TO "commentCredits";

ALTER TABLE "ItemUserAgg" RENAME COLUMN "zapSats" TO "tipPiconeros";
ALTER TABLE "ItemUserAgg" RENAME COLUMN "downZapSats" TO "downvotePiconeros";

ALTER TABLE "Earn" RENAME COLUMN "msats" TO "piconeros";
ALTER TABLE "AggRewards" RENAME COLUMN "msats" TO "piconeros";
ALTER TABLE "PayIn" RENAME COLUMN "mcost" TO "piconeros";

-- ------------------------------------------------------------------
-- Index replacements for the renamed Item columns
-- ------------------------------------------------------------------
DROP INDEX "Item_downMsats_idx";
DROP INDEX "Item_lastZapAt_idx";
DROP INDEX "Item_subNames_downMsats_idx";
DROP INDEX "Item_userId_downMsats_idx";

CREATE INDEX "Item_downPiconeros_idx" ON "Item"("downPiconeros");
CREATE INDEX "Item_lastTipAt_idx" ON "Item"("lastTipAt");
CREATE INDEX "Item_subNames_downPiconeros_idx" ON "Item" USING GIN ("subNames", "downPiconeros" int8_ops);
CREATE INDEX "Item_userId_downPiconeros_idx" ON "Item"("userId", "downPiconeros");

-- ------------------------------------------------------------------
-- item_ranking trigger rewritten for the renamed columns
-- (expression math kept byte-identical to prune then baseline/evergreen
--  function; only the column identifiers change: msats -> piconeros,
--  "commentMsats" -> "commentPiconeros", "downMsats" -> "downPiconeros",
--  "commentDownMsats" -> "commentDownPiconeros")
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION item_ranking_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    + COALESCE(NEW.boost, 0)::double precision * 1000.0
    + COALESCE(NEW."commentPiconeros", 0)::double precision * 0.25
    + COALESCE(NEW."commentCost", 0)::double precision * 250.0
    + COALESCE(NEW."commentBoost", 0)::double precision * 250.0
    - COALESCE(NEW."downPiconeros", 0)::double precision
    - COALESCE(NEW."commentDownPiconeros", 0)::double precision * 0.1
  );

  -- 2. compute lit centered sum weight from field deltas
  IF TG_OP = 'INSERT' THEN
    w := (
      COALESCE(NEW.cost, 0)::double precision
      + COALESCE(NEW.piconeros, 0)::double precision / 1000.0
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
$$;

DROP TRIGGER item_ranking ON "Item";
CREATE TRIGGER item_ranking
  BEFORE INSERT OR UPDATE OF cost, piconeros, boost, "commentPiconeros", "commentCost", "commentBoost", "downPiconeros", "commentDownPiconeros"
  ON "Item"
  FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();
