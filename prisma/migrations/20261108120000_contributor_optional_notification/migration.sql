ALTER TABLE "Item" ADD COLUMN "contributorDisqualifiedNotifyAt" TIMESTAMP(3);

UPDATE "Item"
SET "contributorDisqualifiedNotifyAt" = "contributorDisqualifiedAt"
WHERE "contributorDisqualifiedAt" IS NOT NULL;
