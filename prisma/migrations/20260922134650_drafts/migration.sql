-- CreateTable
CREATE TABLE "draft" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT,
    "url" TEXT,
    "subName" TEXT,
    "extra" JSONB,
    "moneroWallPricePiconeros" BIGINT,
    "moneroWallThresholdPiconeros" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_upload" (
    "draft_id" INTEGER NOT NULL,
    "upload_id" INTEGER NOT NULL,

    CONSTRAINT "draft_upload_pkey" PRIMARY KEY ("draft_id","upload_id")
);

-- CreateIndex
CREATE INDEX "draft_user_id_idx" ON "draft"("user_id");

-- CreateIndex
CREATE INDEX "draft_upload_upload_id_idx" ON "draft_upload"("upload_id");

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_upload" ADD CONSTRAINT "draft_upload_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_upload" ADD CONSTRAINT "draft_upload_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
