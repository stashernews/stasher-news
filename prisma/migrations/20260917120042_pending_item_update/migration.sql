-- CreateTable
CREATE TABLE "PendingItemUpdate" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "payInId" INTEGER NOT NULL,
    "oldText" TEXT,
    "args" JSONB NOT NULL,

    CONSTRAINT "PendingItemUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingItemUpdate_payInId_key" ON "PendingItemUpdate"("payInId");

-- CreateIndex
CREATE INDEX "PendingItemUpdate_itemId_idx" ON "PendingItemUpdate"("itemId");

-- CreateIndex
CREATE INDEX "PendingItemUpdate_created_at_idx" ON "PendingItemUpdate"("created_at");

-- AddForeignKey
ALTER TABLE "PendingItemUpdate" ADD CONSTRAINT "PendingItemUpdate_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingItemUpdate" ADD CONSTRAINT "PendingItemUpdate_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
