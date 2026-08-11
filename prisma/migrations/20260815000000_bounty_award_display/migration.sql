-- A-13 award indication: mark the winning comment + link the bounty post to it.
-- Written atomically in the payBounty claim transaction. Self-FK follows the
-- rootId convention (ON DELETE SET NULL).

ALTER TABLE "Item" ADD COLUMN "bountyAwardedAt" TIMESTAMP(3);
ALTER TABLE "Item" ADD COLUMN "bountyWinnerCommentId" INTEGER;
ALTER TABLE "Item"
  ADD CONSTRAINT "Item_bountyWinnerCommentId_fkey"
  FOREIGN KEY ("bountyWinnerCommentId") REFERENCES "Item"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
