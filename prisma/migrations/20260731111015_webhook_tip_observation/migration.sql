/*
  Warnings:

  - Made the column `paymentId` on table `ObservedTip` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
ALTER TYPE "ObservedState" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "ObservedTip" ADD COLUMN     "webhookEventId" TEXT,
ALTER COLUMN "recipientMajor" DROP NOT NULL,
ALTER COLUMN "recipientMinor" DROP NOT NULL,
ALTER COLUMN "paymentId" SET NOT NULL;
