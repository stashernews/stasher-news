/*
  Warnings:

  - You are about to drop the column `moneroAccountId` on the `Item` table. All the data in the column will be lost.
  - You are about to drop the column `subaddress` on the `Item` table. All the data in the column will be lost.
  - You are about to drop the column `subaddressIndexMajor` on the `Item` table. All the data in the column will be lost.
  - You are about to drop the column `subaddressIndexMinor` on the `Item` table. All the data in the column will be lost.
  - You are about to drop the column `moneroAddress` on the `Sub` table. All the data in the column will be lost.
  - You are about to drop the column `assignedPostId` on the `SubaddressIndex` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Item" DROP CONSTRAINT "Item_moneroAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SubaddressIndex" DROP CONSTRAINT "SubaddressIndex_assignedPostId_fkey";

-- AlterTable
ALTER TABLE "Item" DROP COLUMN "moneroAccountId",
DROP COLUMN "subaddress",
DROP COLUMN "subaddressIndexMajor",
DROP COLUMN "subaddressIndexMinor";

-- AlterTable
ALTER TABLE "Sub" DROP COLUMN "moneroAddress";

-- AlterTable
ALTER TABLE "SubaddressIndex" DROP COLUMN "assignedPostId";
