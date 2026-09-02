-- Rename the default platform turf 'meta' -> 'stasher' (platform-branded site
-- meta turf for the mainnet release). Complements the in-place edit of
-- 20260802120000_seed_default_territories: fresh installs seed 'stasher'
-- directly and this is a no-op there; DBs where the old seed already ran
-- (dev/stagenet) converge here.
--
-- Cascade analysis (20260727054513_stealth_baseline): every FK into
-- Sub(name) carries ON UPDATE CASCADE (UserSubTrust, ItemSub, SubBranding,
-- MuteSub, SubSubscription, TerritoryTransfer, Domain, SubPayIn, and the
-- self-FK Sub.parentName), so the Sub UPDATE cascades automatically. The
-- cascaded ItemSub UPDATE fires the item_subnames AFTER UPDATE trigger
-- (20260802200000_item_path_subnames_triggers), recomputing Item.subNames.
-- FK-less subName carriers need explicit updates (no-ops on fresh DBs):
-- Item.subName (denormalized), AbuseSignal, FeeObservation, ObservedSubFee,
-- SubFeePidMap. ObservedTip/ObservedDownvote/DownvotePidMap have no subName.
-- Idempotent: safe to re-run.
UPDATE "Item" SET "subName" = 'stasher' WHERE "subName" = 'meta';
UPDATE "Sub" SET "name" = 'stasher' WHERE "name" = 'meta';
UPDATE "AbuseSignal" SET "subName" = 'stasher' WHERE "subName" = 'meta';
UPDATE "FeeObservation" SET "subName" = 'stasher' WHERE "subName" = 'meta';
UPDATE "ObservedSubFee" SET "subName" = 'stasher' WHERE "subName" = 'meta';
UPDATE "SubFeePidMap" SET "subName" = 'stasher' WHERE "subName" = 'meta';
