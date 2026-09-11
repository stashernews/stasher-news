-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "ipHash" TEXT;

-- CreateIndex
CREATE INDEX "Upload.userId_paid_createdAt_index" ON "Upload"("userId", "paid", "created_at");

-- CreateIndex
CREATE INDEX "Upload.ipHash_paid_createdAt_index" ON "Upload"("ipHash", "paid", "created_at");
