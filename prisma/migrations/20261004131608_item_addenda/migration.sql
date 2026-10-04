-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "addendumRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "addendumText" TEXT,
ADD COLUMN     "addendumUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ItemAddendumUpload" (
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "uploadId" INTEGER NOT NULL,

    CONSTRAINT "ItemAddendumUpload_pkey" PRIMARY KEY ("itemId","uploadId")
);

-- CreateIndex
CREATE INDEX "ItemAddendumUpload_uploadId_idx" ON "ItemAddendumUpload"("uploadId");

-- AddForeignKey
ALTER TABLE "ItemAddendumUpload" ADD CONSTRAINT "ItemAddendumUpload_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAddendumUpload" ADD CONSTRAINT "ItemAddendumUpload_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
