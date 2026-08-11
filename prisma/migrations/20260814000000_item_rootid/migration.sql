-- Restore Item.rootId maintenance (2026-08-11 live bug: bounty awards always
-- rejected with 'award target must be a comment on this bounty post').
--
-- The fork's restored item_path trigger (20260802200000) only derives the
-- ltree `path`; upstream's update_item_path (20230126184544_root_id_funcs)
-- derives BOTH path and rootId (the top-level post id, from the parent's
-- path). Since the fork's restore, every app-created comment has rootId NULL:
--   - the A-13 award guard `winner.rootId !== (item.rootId ?? item.id)`
--     rejects every real comment (observed live on bounty post 2808 /
--     comment 2884);
--   - pinItem's root-reply check (`item.parentId !== item.rootId`) and the
--     Item.root resolver (`if (!item.rootId) return null`) are likewise
--     silently broken.
--
-- This migration mirrors upstream's trigger semantics (rootId = the first
-- path element of the parent) and backfills existing comments. Trigger
-- binding unchanged: item_path fires BEFORE INSERT (always) and on UPDATE OF
-- "parentId" (moved comments get a recomputed rootId).

CREATE OR REPLACE FUNCTION item_path_sql() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p ltree;
  r INTEGER;
BEGIN
  IF NEW."parentId" IS NULL THEN
    p := ''::ltree;
    r := NULL;
  ELSE
    SELECT path, ltree2text(subltree(path, 0, 1))::integer
    INTO p, r
    FROM "Item" WHERE id = NEW."parentId";
  END IF;
  NEW.path := p || NEW.id::text::ltree;
  NEW."rootId" := r;
  RETURN NEW;
END;
$$;

-- Backfill comments created before this migration (rootId currently NULL).
UPDATE "Item"
SET "rootId" = ltree2text(subltree(path, 0, 1))::integer
WHERE "parentId" IS NOT NULL AND "rootId" IS NULL;
