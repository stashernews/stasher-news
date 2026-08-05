-- DropForeignKey
ALTER TABLE "ItemForward" DROP CONSTRAINT "ItemForward_itemId_fkey";

-- DropForeignKey
ALTER TABLE "ItemForward" DROP CONSTRAINT "ItemForward_userId_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "noteForwardedPiconeros";

-- DropTable
DROP TABLE "ItemForward";
