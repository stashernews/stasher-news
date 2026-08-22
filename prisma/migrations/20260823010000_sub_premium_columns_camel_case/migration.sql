/*
  Warnings:

  - Rename covered by upcoming migration.

*/
-- AlterTable
ALTER TABLE "Sub" RENAME COLUMN "post_premium_piconeros" TO "postPremiumPiconeros";
-- AlterTable
ALTER TABLE "Sub" RENAME COLUMN "comment_premium_piconeros" TO "commentPremiumPiconeros";
