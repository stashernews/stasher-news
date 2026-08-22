-- DropForeignKey
ALTER TABLE "ObservedSubFee" DROP CONSTRAINT "ObservedSubFee_pay_in_id_fkey";

-- AlterTable
ALTER TABLE "ObservedSubFee" ALTER COLUMN "pay_in_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ObservedSubFee" ADD CONSTRAINT "ObservedSubFee_pay_in_id_fkey" FOREIGN KEY ("pay_in_id") REFERENCES "PayIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
