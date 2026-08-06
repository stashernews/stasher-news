/*
  Warnings:

  - You are about to drop the column `hideUriDesc` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `noteDeposits` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `noteWithdrawals` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `tipUndos` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "hideUriDesc",
DROP COLUMN "noteDeposits",
DROP COLUMN "noteWithdrawals",
DROP COLUMN "tipUndos";
