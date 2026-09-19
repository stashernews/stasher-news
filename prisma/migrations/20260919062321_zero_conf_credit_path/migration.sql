-- AlterEnum
ALTER TYPE "AbuseSignalKind" ADD VALUE 'TX_NOT_FOUND_EXCLUDED';

-- AlterEnum
ALTER TYPE "TipExclusionReason" ADD VALUE 'TX_NOT_FOUND';

-- AlterTable
ALTER TABLE "ObservedTip" ADD COLUMN     "amountVerifiedAt" TIMESTAMP(3);
