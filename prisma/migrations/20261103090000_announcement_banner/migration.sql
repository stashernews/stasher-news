-- The operator-written announcement shown site-wide while Snl.live is on.
ALTER TABLE "Snl" ADD COLUMN "message" TEXT NOT NULL DEFAULT '';
-- The old banner's text was hard-coded; a live row has no message to show, and
-- "on without a message" is now refused, so start every existing row off.
UPDATE "Snl" SET "live" = false;
