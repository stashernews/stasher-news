-- Tip settings are piconeros amounts and must hold values beyond 2^31-1
-- (e.g. 0.01 XMR = 10,000,000,000 piconeros) — widen to bigint per the
-- repo's money convention.
ALTER TABLE users ALTER COLUMN "tipDefaultPiconeros" TYPE bigint;
ALTER TABLE users ALTER COLUMN "tipRandomMin" TYPE bigint;
ALTER TABLE users ALTER COLUMN "tipRandomMax" TYPE bigint;
