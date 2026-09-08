-- Restore search indexing triggers, dropped in 20260727054513_stealth_baseline.
--
-- Mirrors upstream stacker.news migrations 20220126155041_search_triggers
-- (Item) and 20240415202735_index_item_on_bookmark_change (Bookmark): any
-- insert/update of an Item enqueues a pgboss `indexItem` job (plus one for
-- its parent, so parent ncomments/ranktop re-index), and bookmark
-- create/update/delete re-indexes the bookmarked item (DELETE passes
-- `updatedAt` = now() so the indexed version is displaced via version
-- conflict).
--
-- No trigger is needed on ItemAct/PayIn: this fork's payIn engine updates
-- Item rows directly (cost, boosting, ranking) — which the existing
-- `item_ranking` BEFORE-trigger already proves — so an Item UPDATE fires
-- here too.
--
-- The worker only consumes `indexItem` when the search service is enabled
-- (worker/index.js, isServiceEnabled('search')); with search disabled the
-- jobs are enqueued and expire harmlessly.

CREATE OR REPLACE FUNCTION index_item() RETURNS TRIGGER AS $$
    BEGIN
        -- insert indexItem pgboss.job with id
        INSERT INTO pgboss.job (name, data) VALUES ('indexItem', jsonb_build_object('id', NEW.id));
        -- insert indexItem pgboss.job from parentId if there's a parentId
        IF NEW."parentId" IS NOT NULL THEN
            INSERT INTO pgboss.job (name, data) VALUES ('indexItem', jsonb_build_object('id', NEW."parentId"));
        END IF;
        RETURN NEW;
    END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS index_item ON "Item";
CREATE TRIGGER index_item
    AFTER INSERT OR UPDATE ON "Item"
    FOR EACH ROW
    EXECUTE PROCEDURE index_item();

CREATE OR REPLACE FUNCTION index_bookmarked_item() RETURNS TRIGGER AS $$
    BEGIN
        -- if a bookmark was created or updated, `NEW` will be used
        IF NEW IS NOT NULL THEN
            INSERT INTO pgboss.job (name, data) VALUES ('indexItem', jsonb_build_object('id', NEW."itemId"));
            RETURN NEW;
        END IF;
        -- if a bookmark was deleted, `OLD` will be used
        IF OLD IS NOT NULL THEN
            -- include `updatedAt` in the `indexItem` job as `now()` to indicate when the indexed item should think it was updated
            INSERT INTO pgboss.job (name, data) VALUES ('indexItem', jsonb_build_object('id', OLD."itemId", 'updatedAt', now()));
            RETURN OLD;
        END IF;
        -- This should never be reached
        RETURN NULL;
    END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS index_bookmarked_item ON "Bookmark";
CREATE TRIGGER index_bookmarked_item
    AFTER INSERT OR UPDATE OR DELETE ON "Bookmark"
    FOR EACH ROW
    EXECUTE PROCEDURE index_bookmarked_item();
