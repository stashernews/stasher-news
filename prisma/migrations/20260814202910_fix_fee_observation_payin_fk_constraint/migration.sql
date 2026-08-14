-- DropForeignKey
ALTER TABLE "FeeObservation" DROP CONSTRAINT "FeeObservation_payInId_fkey";

-- AddForeignKey
ALTER TABLE "FeeObservation" ADD CONSTRAINT "FeeObservation_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
