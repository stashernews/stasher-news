-- Approved trust-edge bounds exceed int4; keep whole piconeros exact.
ALTER TABLE "SiteSettings"
  ALTER COLUMN "trustPicoMin" TYPE BIGINT,
  ALTER COLUMN "trustAgainstPicoMin" TYPE BIGINT;
