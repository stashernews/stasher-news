-- CreateTable
CREATE TABLE "chain_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "chainHeight" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_state_pkey" PRIMARY KEY ("id")
);
