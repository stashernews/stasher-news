-- Turf pins move onto the post–turf membership so the same post can be
-- pinned independently in every turf that carries it. Additive: the legacy
-- Item.pinId link and the Pin table stay for reply and global (no-turf) pins.

ALTER TABLE "ItemSub" ADD COLUMN "pinPosition" INTEGER;
ALTER TABLE "ItemSub" ADD CONSTRAINT "ItemSub_pinPosition_positive"
  CHECK ("pinPosition" IS NULL OR "pinPosition" > 0);
CREATE INDEX "ItemSub_subName_pinPosition_idx"
  ON "ItemSub" ("subName", "pinPosition");

-- The membership denormalization trigger (item_subnames) must not fire on
-- pin-position-only updates: rewriting Item.subNames there would touch the
-- parent Item row (and its row lock) during concurrent pin writes. Scope the
-- UPDATE event to the membership identity columns; INSERT and DELETE already
-- change membership and keep firing it.
DROP TRIGGER item_subnames ON "ItemSub";
CREATE TRIGGER item_subnames
  AFTER INSERT OR DELETE OR UPDATE OF "itemId", "subName" ON "ItemSub"
  FOR EACH ROW EXECUTE FUNCTION item_subnames_sql();
