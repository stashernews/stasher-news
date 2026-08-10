-- A-14 follow-up (operator decision B): Item.boost/commentBoost Int -> BigInt so
-- boosts above ~2.147e9 piconeros (0.0021 XMR) no longer overflow the DETECTION
-- increment (worker/rewardsWalletObserver.js applyBoostDetected). The ranking
-- trigger is unaffected: COALESCE(NEW.boost, 0)::double precision is valid for
-- bigint. Column defaults (0) unchanged.
--
-- PG 16 refuses ALTER TYPE on columns listed in a column-list trigger
-- ("cannot alter type of a column used in a trigger definition"), so the two
-- Item triggers referencing boost/commentBoost (item_ranking,
-- item_net_investment) are dropped and recreated with their exact prior
-- definitions around the ALTERs. The trigger FUNCTIONS are untouched.

BEGIN;

DROP TRIGGER item_ranking ON "Item";
DROP TRIGGER item_net_investment ON "Item";

ALTER TABLE "Item" ALTER COLUMN "boost" TYPE BIGINT;
ALTER TABLE "Item" ALTER COLUMN "commentBoost" TYPE BIGINT;

CREATE TRIGGER item_ranking BEFORE INSERT OR UPDATE OF cost, piconeros, boost, "commentPiconeros", "commentCost", "commentBoost", "downPiconeros", "commentDownPiconeros" ON public."Item" FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();
CREATE TRIGGER item_net_investment BEFORE INSERT OR UPDATE OF cost, boost, piconeros, "downPiconeros", "feeInvestmentPiconeros" ON public."Item" FOR EACH ROW EXECUTE FUNCTION item_net_investment_trigger();

COMMIT;
