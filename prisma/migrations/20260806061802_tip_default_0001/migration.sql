-- AlterTable
ALTER TABLE "users" ALTER COLUMN "tipDefaultPiconeros" SET DEFAULT 1000000000;

-- platform tip default is 0.001 XMR; apply to all users
UPDATE users SET "tipDefaultPiconeros" = 1000000000;
