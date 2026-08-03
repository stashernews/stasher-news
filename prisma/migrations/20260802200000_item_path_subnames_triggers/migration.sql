-- Restore the Item.path (ltree) and Item.subNames (CITEXT[]) maintenance triggers
-- that upstream stacker.news relies on but the stealth-baseline migration omitted.
--
-- Without these triggers every app-created Item has NULL path and NULL subNames,
-- because Item.path is an Unsupported("ltree") column that Prisma's item.create
-- cannot write, and Item.subNames is a denormalized array maintained from the
-- ItemSub join table. NULL path crashes item-info.js (`item.path.split('.')`) and
-- NULL subNames makes the item invisible in territory feeds (which filter on
-- "Item"."subNames" @> ARRAY[...] / IS NOT NULL).
--
-- 1. item_path: BEFORE INSERT OR UPDATE OF "parentId" — derives the ltree path
--    from the parent's path (root = just its id; reply = parent.path.id).
-- 2. item_subnames: AFTER INSERT/UPDATE/DELETE on ItemSub — recomputes
--    Item.subNames as the aggregate of the item's ItemSub.subName rows.
-- 3. Backfill existing rows that pre-date the triggers.

-- =====================================================================
-- 1. item_path
-- =====================================================================

CREATE OR REPLACE FUNCTION item_path_sql() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p ltree;
BEGIN
  IF NEW."parentId" IS NULL THEN
    p := ''::ltree;
  ELSE
    SELECT path INTO p FROM "Item" WHERE id = NEW."parentId";
  END IF;
  NEW.path := p || NEW.id::text::ltree;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS item_path ON "Item";
CREATE TRIGGER item_path
  BEFORE INSERT OR UPDATE OF "parentId" ON "Item"
  FOR EACH ROW EXECUTE FUNCTION item_path_sql();

-- =====================================================================
-- 2. item_subnames
-- =====================================================================

CREATE OR REPLACE FUNCTION item_subnames_sql() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item_id INT;
BEGIN
  item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."itemId" ELSE NEW."itemId" END;
  UPDATE "Item"
  SET "subNames" = (SELECT array_agg("subName") FROM "ItemSub" WHERE "itemId" = item_id)
  WHERE id = item_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS item_subnames ON "ItemSub";
CREATE TRIGGER item_subnames
  AFTER INSERT OR UPDATE OR DELETE ON "ItemSub"
  FOR EACH ROW EXECUTE FUNCTION item_subnames_sql();

-- =====================================================================
-- 3. Backfill existing rows
-- =====================================================================

-- Root items (no parentId) with NULL path: path = id
UPDATE "Item" SET path = id::text::ltree WHERE "parentId" IS NULL AND path IS NULL;
-- Replies with NULL path: path = parent.path || id (single pass; nested chains are
-- rare in practice and the trigger will fix any future inserts automatically).
UPDATE "Item"
SET path = (SELECT path FROM "Item" p WHERE p.id = "Item"."parentId") || "Item".id::text::ltree
WHERE "parentId" IS NOT NULL AND path IS NULL;
-- subNames from ItemSub join
UPDATE "Item"
SET "subNames" = (SELECT array_agg("subName") FROM "ItemSub" WHERE "itemId" = "Item".id)
WHERE "subNames" IS NULL;
