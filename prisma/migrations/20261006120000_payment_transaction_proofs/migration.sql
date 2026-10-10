-- Payment transaction proofs (Finding #1, Task 3): the encrypted proof store,
-- the escrow dispatch journal, and the corruption barriers that keep every
-- proof atomically paired with exactly one owner.
--
-- This file runs as ONE transaction (Prisma migrate, PostgreSQL): any RAISE
-- below aborts every statement above it, leaving the database untouched.
-- No financial backfill, no legacy secret synthesis, no sequence inserts:
-- existing (legacy) journal rows simply keep null capture columns.
--
-- Barrier design:
--   * CHECK constraints are the immediate backstops: exactly one owner,
--     envelope byte lengths, digest formats, v1 format versions, nonnegative
--     amounts/accounts, the hot journal's all-or-nothing capture tuple, the
--     escrow kind/leg consistency, and lowercase-64 tx hashes.
--   * DEFERRABLE INITIALLY DEFERRED constraint triggers re-check the
--     bidirectional proofId/ownerId pairing (existence, exactly one owner,
--     same claimDigest, complete proof-era tuple) at COMMIT: a journal and its
--     proof can only land together, a mid-transaction repair commits, and a
--     proof can never promote a legacy (capture-less) owner row.
--   * BEFORE UPDATE triggers make captured identity/claims/principal/fee/
--     source/hash/metadata immutable and allow rotation to replace only the
--     envelope bytes/headers, and only with an increasing revision.
--   * Every owner/proof foreign key is ON DELETE RESTRICT and a deferred guard
--     rejects a standalone proof deletion; deleting a proof and its owner is
--     permitted only together in one transaction (fixture cleanup or a
--     separately authorized lifecycle — never automatic production GC).

-- CreateEnum
CREATE TYPE "EscrowWalletTxKind" AS ENUM ('AWARD', 'RECLAIM', 'ROLLOVER', 'LEGACY_SEPARATE_FEE');

-- CreateEnum
CREATE TYPE "EscrowPaymentLeg" AS ENUM ('DISPOSITION', 'LEGACY_SEPARATE_FEE');

-- AlterTable (hot journal capture columns; nullable so legacy rows stay valid)
ALTER TABLE "RewardsWalletTransaction" ADD COLUMN     "captureContractVersion" INTEGER,
ADD COLUMN     "claimDigest" TEXT,
ADD COLUMN     "dispatchId" UUID,
ADD COLUMN     "paymentClaims" JSONB,
ADD COLUMN     "proofId" UUID,
ADD COLUMN     "relayProvenance" TEXT;

-- CreateTable
CREATE TABLE "EscrowWalletTransaction" (
    "id" BIGSERIAL NOT NULL,
    "network" "Network" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "dispatchId" UUID NOT NULL,
    "proofId" UUID NOT NULL,
    "captureContractVersion" INTEGER NOT NULL,
    "claimDigest" TEXT NOT NULL,
    "paymentClaims" JSONB NOT NULL,
    "kind" "EscrowWalletTxKind" NOT NULL,
    "leg" "EscrowPaymentLeg" NOT NULL,
    "bountyPaymentId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "accountIndex" INTEGER NOT NULL,
    "principalPiconeros" BIGINT NOT NULL,
    "networkFeePiconeros" BIGINT NOT NULL,
    "metadata" JSONB NOT NULL,
    "state" "RewardsWalletTxState" NOT NULL DEFAULT 'PREPARED',
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relayAttemptedAt" TIMESTAMP(3),
    "relayedAt" TIMESTAMP(3),
    "relayProvenance" TEXT,

    CONSTRAINT "EscrowWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransactionProof" (
    "id" UUID NOT NULL,
    "rewardsJournalId" BIGINT,
    "escrowJournalId" BIGINT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "masterKeyVersion" INTEGER NOT NULL,
    "bindingVersion" INTEGER NOT NULL,
    "envelopeVersion" INTEGER NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "claimDigest" TEXT NOT NULL,
    "bindingDigest" TEXT NOT NULL,
    "dataNonce" BYTEA NOT NULL,
    "dataTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "wrapNonce" BYTEA NOT NULL,
    "wrapTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransactionProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardsWalletTransaction_dispatchId_key" ON "RewardsWalletTransaction"("dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardsWalletTransaction_proofId_key" ON "RewardsWalletTransaction"("proofId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowWalletTransaction_dispatchId_key" ON "EscrowWalletTransaction"("dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowWalletTransaction_proofId_key" ON "EscrowWalletTransaction"("proofId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowWalletTransaction_network_walletAddress_txHash_key" ON "EscrowWalletTransaction"("network", "walletAddress", "txHash");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowWalletTransaction_network_walletAddress_bountyPaymentId_leg_key" ON "EscrowWalletTransaction"("network", "walletAddress", "bountyPaymentId", "leg");

-- CreateIndex
CREATE INDEX "EscrowWalletTransaction_network_walletAddress_state_idx" ON "EscrowWalletTransaction"("network", "walletAddress", "state");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransactionProof_rewardsJournalId_key" ON "PaymentTransactionProof"("rewardsJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransactionProof_escrowJournalId_key" ON "PaymentTransactionProof"("escrowJournalId");

-- AddForeignKey
ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_bountyPaymentId_fkey" FOREIGN KEY ("bountyPaymentId") REFERENCES "BountyPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_rewardsJournalId_fkey" FOREIGN KEY ("rewardsJournalId") REFERENCES "RewardsWalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_escrowJournalId_fkey" FOREIGN KEY ("escrowJournalId") REFERENCES "EscrowWalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- CHECK constraints (immediate storage-layer backstops)
-- =============================================================================

-- Exactly one owner: the hot rewards journal OR the escrow journal, never
-- both, never neither.
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_single_owner"
  CHECK (num_nonnulls("rewardsJournalId", "escrowJournalId") = 1);

-- Positive revision and real master-key generation.
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_revision_key_versions"
  CHECK ("revision" > 0 AND "masterKeyVersion" > 0);

-- EnvelopeV1 authenticated byte fields: 12/12-byte nonces, 16/16-byte tags,
-- 32-byte wrapped DEK.
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_envelope_byte_lengths"
  CHECK (octet_length("dataNonce") = 12 AND octet_length("wrapNonce") = 12
    AND octet_length("dataTag") = 16 AND octet_length("wrapTag") = 16
    AND octet_length("wrappedDek") = 32);

-- v1 format versions (the actual master key version is separate and only
-- bounded above by revision_key_versions).
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_format_versions"
  CHECK ("bindingVersion" = 1 AND "envelopeVersion" = 1 AND "payloadVersion" = 1);

-- Lowercase SHA-256 hex digests for the claims and binding identities.
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_digest_formats"
  CHECK ("claimDigest" ~ '^[0-9a-f]{64}$' AND "bindingDigest" ~ '^[0-9a-f]{64}$');

-- An envelope always carries ciphertext; an absent ciphertext is corruption,
-- not an empty proof.
ALTER TABLE "PaymentTransactionProof" ADD CONSTRAINT "PaymentTransactionProof_ciphertext_present"
  CHECK (octet_length("ciphertext") > 0);

-- Hot journal capture: the five proof-era columns are written together as a
-- complete v1 tuple, or the row is a legacy row with all five null.
ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_capture_tuple"
  CHECK (
    ("dispatchId" IS NULL AND "captureContractVersion" IS NULL AND "claimDigest" IS NULL
      AND "paymentClaims" IS NULL AND "proofId" IS NULL)
    OR
    ("dispatchId" IS NOT NULL AND "captureContractVersion" = 1 AND "claimDigest" IS NOT NULL
      AND "paymentClaims" IS NOT NULL AND "proofId" IS NOT NULL)
  );

ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_capture_claim_digest_format"
  CHECK ("claimDigest" IS NULL OR "claimDigest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "RewardsWalletTransaction" ADD CONSTRAINT "RewardsWalletTransaction_account_index_nonnegative"
  CHECK ("accountIndex" >= 0);

-- Escrow dispatch journal: always a complete proof-era capture (no legacy
-- escrow rows are ever synthesized).
ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_capture_v1"
  CHECK ("captureContractVersion" = 1);

ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_claim_digest_format"
  CHECK ("claimDigest" ~ '^[0-9a-f]{64}$');

-- Kind/leg consistency: the legacy separate-fee kind is exactly the legacy
-- separate-fee leg; every other kind settles the disposition.
ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_kind_leg_consistent"
  CHECK ((kind = 'LEGACY_SEPARATE_FEE') = ("leg" = 'LEGACY_SEPARATE_FEE'));

ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_amounts_nonnegative"
  CHECK ("principalPiconeros" >= 0 AND "networkFeePiconeros" >= 0 AND "accountIndex" >= 0);

ALTER TABLE "EscrowWalletTransaction" ADD CONSTRAINT "EscrowWalletTransaction_hash"
  CHECK ("txHash" ~ '^[0-9a-f]{64}$');

-- =============================================================================
-- Deferred pair-integrity triggers (checked at COMMIT)
-- =============================================================================

-- Proof-side check: exactly one existing owner whose proofId points back at
-- this proof, with the same claimDigest and a complete proof-era capture
-- tuple (a proof can never promote a legacy owner row).
CREATE FUNCTION "payment_proof_pair_check"(proof_id uuid) RETURNS void AS $$
DECLARE
  proof "PaymentTransactionProof";
  hot "RewardsWalletTransaction";
  escrow "EscrowWalletTransaction";
BEGIN
  SELECT * INTO proof FROM "PaymentTransactionProof" WHERE id = proof_id;
  IF NOT FOUND THEN
    RETURN; -- deleted later in the same transaction; the owner side re-checks
  END IF;
  IF proof."rewardsJournalId" IS NOT NULL THEN
    SELECT * INTO hot FROM "RewardsWalletTransaction" WHERE id = proof."rewardsJournalId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_OWNER_MISSING: payment proof % references a missing rewards journal row', proof_id;
    END IF;
    -- The promotion barrier is checked before the backlink so a proof aimed at
    -- a legacy (capture-less) owner row reports the specific reason.
    IF hot."dispatchId" IS NULL OR hot."captureContractVersion" IS NULL OR hot."paymentClaims" IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_LEGACY_PROMOTION: payment proof % cannot promote legacy rewards journal %', proof_id, hot."id";
    END IF;
    IF hot."proofId" IS DISTINCT FROM proof."id" THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_PAIR_MISMATCH: rewards journal % does not reference proof %', hot."id", proof_id;
    END IF;
    IF hot."claimDigest" IS DISTINCT FROM proof."claimDigest" THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_DIGEST_MISMATCH: payment proof % claimDigest differs from its rewards journal %', proof_id, hot."id";
    END IF;
  ELSE
    SELECT * INTO escrow FROM "EscrowWalletTransaction" WHERE id = proof."escrowJournalId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_OWNER_MISSING: payment proof % references a missing escrow journal row', proof_id;
    END IF;
    IF escrow."proofId" IS DISTINCT FROM proof."id" THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_PAIR_MISMATCH: escrow journal % does not reference proof %', escrow."id", proof_id;
    END IF;
    IF escrow."claimDigest" IS DISTINCT FROM proof."claimDigest" THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_DIGEST_MISMATCH: payment proof % claimDigest differs from its escrow journal %', proof_id, escrow."id";
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "payment_proof_pair_trigger"() RETURNS trigger AS $$
BEGIN
  PERFORM "payment_proof_pair_check"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PaymentTransactionProof_pair_deferred"
  AFTER INSERT OR UPDATE ON "PaymentTransactionProof"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "payment_proof_pair_trigger"();

-- Hot-owner check: a proof-era journal row always references an existing
-- proof that links back with the same claimDigest; legacy rows (proofId null)
-- have nothing to pair.
CREATE FUNCTION "rewards_journal_pair_check"(owner_id bigint) RETURNS void AS $$
DECLARE
  owner "RewardsWalletTransaction";
  proof "PaymentTransactionProof";
BEGIN
  SELECT * INTO owner FROM "RewardsWalletTransaction" WHERE id = owner_id;
  IF NOT FOUND THEN
    RETURN; -- owner deleted later in the same transaction (with its proof)
  END IF;
  IF owner."proofId" IS NULL THEN
    RETURN; -- legacy row: no proof-era identity exists to check
  END IF;
  IF owner."dispatchId" IS NULL OR owner."captureContractVersion" IS NULL
    OR owner."claimDigest" IS NULL OR owner."paymentClaims" IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_CAPTURE_INCOMPLETE: rewards journal % has an incomplete proof-era capture tuple', owner_id;
  END IF;
  SELECT * INTO proof FROM "PaymentTransactionProof" WHERE id = owner."proofId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_MISSING: rewards journal % references missing payment proof %', owner_id, owner."proofId";
  END IF;
  IF proof."rewardsJournalId" IS DISTINCT FROM owner."id" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_PAIR_MISMATCH: payment proof % does not reference rewards journal %', proof."id", owner_id;
  END IF;
  IF proof."claimDigest" IS DISTINCT FROM owner."claimDigest" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_DIGEST_MISMATCH: rewards journal % claimDigest differs from payment proof %', owner_id, proof."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "rewards_journal_pair_trigger"() RETURNS trigger AS $$
BEGIN
  PERFORM "rewards_journal_pair_check"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "RewardsWalletTransaction_pair_deferred"
  AFTER INSERT OR UPDATE ON "RewardsWalletTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "rewards_journal_pair_trigger"();

-- Escrow-owner check: same pairing rules; escrow rows always have a proofId.
CREATE FUNCTION "escrow_journal_pair_check"(owner_id bigint) RETURNS void AS $$
DECLARE
  owner "EscrowWalletTransaction";
  proof "PaymentTransactionProof";
BEGIN
  SELECT * INTO owner FROM "EscrowWalletTransaction" WHERE id = owner_id;
  IF NOT FOUND THEN
    RETURN; -- owner deleted later in the same transaction (with its proof)
  END IF;
  SELECT * INTO proof FROM "PaymentTransactionProof" WHERE id = owner."proofId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_MISSING: escrow journal % references missing payment proof %', owner_id, owner."proofId";
  END IF;
  IF proof."escrowJournalId" IS DISTINCT FROM owner."id" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_PAIR_MISMATCH: payment proof % does not reference escrow journal %', proof."id", owner_id;
  END IF;
  IF proof."claimDigest" IS DISTINCT FROM owner."claimDigest" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_DIGEST_MISMATCH: escrow journal % claimDigest differs from payment proof %', owner_id, proof."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "escrow_journal_pair_trigger"() RETURNS trigger AS $$
BEGIN
  PERFORM "escrow_journal_pair_check"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "EscrowWalletTransaction_pair_deferred"
  AFTER INSERT OR UPDATE ON "EscrowWalletTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "escrow_journal_pair_trigger"();

-- Standalone proof deletion guard: an owner row still referencing the deleted
-- proof (immutable proofId) fails the commit. A deliberate teardown deletes
-- the proof and its owner in one transaction; the guard passes only when no
-- owner references the deleted proof at COMMIT.
CREATE FUNCTION "payment_proof_delete_guard"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RewardsWalletTransaction" WHERE "proofId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "EscrowWalletTransaction" WHERE "proofId" = OLD."id") THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_DELETE_RESTRICTED: payment proof % is still referenced by its owner; delete the pair together or not at all', OLD."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PaymentTransactionProof_delete_guard"
  AFTER DELETE ON "PaymentTransactionProof"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "payment_proof_delete_guard"();

-- =============================================================================
-- Immutability triggers (immediate, BEFORE UPDATE)
-- =============================================================================

-- Captured journal facts on PROOF-ERA rows can never change: identity
-- (network, wallet, hash), claims (dispatchId, capture contract, claimDigest,
-- paymentClaims, proofId), principal, fee, source account, distribution, kind,
-- metadata. LEGACY rows (incomplete/null capture tuple) are deliberately
-- EXEMPT: the amendment §8 legacy repair requires a legacy mutable/missing
-- recorded fee to be correctable when independently proven, and the plan's own
-- Task 3 text keeps "legacy repair fields and mutable state/timestamps" under
-- the existing rules — legacy rows stay guarded by the reconciliation repair
-- flow's own closed evidence/precondition gates, not by this trigger.
-- Mutable state/timestamps/relay bookkeeping (state, relayAttemptedAt,
-- relayedAt, relayProvenance) follow the existing journal rules either way.
CREATE FUNCTION "rewards_journal_capture_immutable"() RETURNS trigger AS $$
BEGIN
  -- Legacy→capture promotion barrier (final-review I9): a legacy row (OLD
  -- capture tuple incomplete) can NEVER gain a complete capture tuple — not
  -- even in one atomic UPDATE that also inserts the matching proof row,
  -- because the deferred pair checks only ever observe the final complete
  -- state. Legacy rows stay legacy; the separately gated legacy repair flow
  -- corrects recorded fees/state without ever touching the capture tuple.
  IF (OLD."dispatchId" IS NULL OR OLD."captureContractVersion" IS NULL
    OR OLD."claimDigest" IS NULL OR OLD."paymentClaims" IS NULL
    OR OLD."proofId" IS NULL)
    AND NEW."dispatchId" IS NOT NULL AND NEW."captureContractVersion" IS NOT NULL
    AND NEW."claimDigest" IS NOT NULL AND NEW."paymentClaims" IS NOT NULL
    AND NEW."proofId" IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_LEGACY_PROMOTION: rewards wallet journal % cannot gain a capture tuple', OLD."id";
  END IF;
  -- Enforcement scope: COMPLETE capture tuples only (the schema CHECK's
  -- proof-era shape). A legacy row falls through with no immutability
  -- enforcement from this trigger.
  IF OLD."dispatchId" IS NULL OR OLD."captureContractVersion" IS NULL
    OR OLD."claimDigest" IS NULL OR OLD."paymentClaims" IS NULL
    OR OLD."proofId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."network" IS DISTINCT FROM OLD."network"
    OR NEW."walletAddress" IS DISTINCT FROM OLD."walletAddress"
    OR NEW."txHash" IS DISTINCT FROM OLD."txHash"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."accountIndex" IS DISTINCT FROM OLD."accountIndex"
    OR NEW."distributionId" IS DISTINCT FROM OLD."distributionId"
    OR NEW."principalPiconeros" IS DISTINCT FROM OLD."principalPiconeros"
    OR NEW."networkFeePiconeros" IS DISTINCT FROM OLD."networkFeePiconeros"
    OR NEW."metadata" IS DISTINCT FROM OLD."metadata"
    OR NEW."dispatchId" IS DISTINCT FROM OLD."dispatchId"
    OR NEW."captureContractVersion" IS DISTINCT FROM OLD."captureContractVersion"
    OR NEW."claimDigest" IS DISTINCT FROM OLD."claimDigest"
    OR NEW."paymentClaims" IS DISTINCT FROM OLD."paymentClaims"
    OR NEW."proofId" IS DISTINCT FROM OLD."proofId"
    OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_CAPTURE_IMMUTABLE: rewards wallet journal % captured facts cannot change', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RewardsWalletTransaction_capture_immutable"
  BEFORE UPDATE ON "RewardsWalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION "rewards_journal_capture_immutable"();

-- Escrow frozen terms (recipient, prize, fee and fee destination inside the
-- bound claims) and frozen attribution (kind, leg, bountyPaymentId, itemId)
-- are likewise immutable; state/timestamps/relay provenance stay mutable.
CREATE FUNCTION "escrow_journal_capture_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."network" IS DISTINCT FROM OLD."network"
    OR NEW."walletAddress" IS DISTINCT FROM OLD."walletAddress"
    OR NEW."txHash" IS DISTINCT FROM OLD."txHash"
    OR NEW."dispatchId" IS DISTINCT FROM OLD."dispatchId"
    OR NEW."proofId" IS DISTINCT FROM OLD."proofId"
    OR NEW."captureContractVersion" IS DISTINCT FROM OLD."captureContractVersion"
    OR NEW."claimDigest" IS DISTINCT FROM OLD."claimDigest"
    OR NEW."paymentClaims" IS DISTINCT FROM OLD."paymentClaims"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."leg" IS DISTINCT FROM OLD."leg"
    OR NEW."bountyPaymentId" IS DISTINCT FROM OLD."bountyPaymentId"
    OR NEW."itemId" IS DISTINCT FROM OLD."itemId"
    OR NEW."accountIndex" IS DISTINCT FROM OLD."accountIndex"
    OR NEW."principalPiconeros" IS DISTINCT FROM OLD."principalPiconeros"
    OR NEW."networkFeePiconeros" IS DISTINCT FROM OLD."networkFeePiconeros"
    OR NEW."metadata" IS DISTINCT FROM OLD."metadata"
    OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_CAPTURE_IMMUTABLE: escrow wallet journal % captured facts cannot change', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EscrowWalletTransaction_capture_immutable"
  BEFORE UPDATE ON "EscrowWalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION "escrow_journal_capture_immutable"();

-- Proof rows: owner linkage and claimDigest are immutable forever; everything
-- else may only change as a ROTATION — envelope bytes/headers together with a
-- strictly increasing revision (unchanged owner, unchanged claim digest).
CREATE FUNCTION "payment_proof_rotation_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."rewardsJournalId" IS DISTINCT FROM OLD."rewardsJournalId"
    OR NEW."escrowJournalId" IS DISTINCT FROM OLD."escrowJournalId"
    OR NEW."claimDigest" IS DISTINCT FROM OLD."claimDigest"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_ROTATION_INVALID: payment proof % owner linkage and claim digest are immutable', OLD."id";
  END IF;
  IF (NEW."revision", NEW."masterKeyVersion", NEW."bindingVersion", NEW."envelopeVersion",
      NEW."payloadVersion", NEW."bindingDigest", NEW."dataNonce", NEW."dataTag", NEW."ciphertext",
      NEW."wrapNonce", NEW."wrapTag", NEW."wrappedDek")
     IS DISTINCT FROM
     (OLD."revision", OLD."masterKeyVersion", OLD."bindingVersion", OLD."envelopeVersion",
      OLD."payloadVersion", OLD."bindingDigest", OLD."dataNonce", OLD."dataTag", OLD."ciphertext",
      OLD."wrapNonce", OLD."wrapTag", OLD."wrappedDek") THEN
    IF NEW."revision" <= OLD."revision" THEN
      RAISE EXCEPTION 'PAYMENT_PROOF_ROTATION_REVISION: payment proof % rotation must increase revision', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentTransactionProof_rotation_guard"
  BEFORE UPDATE ON "PaymentTransactionProof"
  FOR EACH ROW EXECUTE FUNCTION "payment_proof_rotation_guard"();
