-- StasherNews tiered freebies: free-post monthly counter on User.
-- Mirrors the existing freeCommentCount/freeCommentResetAt pair (camelCase columns, no @map).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "freePostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "freePostResetAt" TIMESTAMP(3);
