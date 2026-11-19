-- Free-reply cooldown: at most one free reply per admin-set window
-- (SiteSettings.freeReplyCooldownMinutes, 0 = off, the shipped default).
-- users.lastFreeReplyAt is stamped whenever a free reply unit is claimed, also
-- while the cooldown is off, so enabling it takes effect immediately.
-- Additive only: the currently deployed client never selects these columns.

ALTER TABLE "users" ADD COLUMN "lastFreeReplyAt" TIMESTAMP(3);

ALTER TABLE "SiteSettings" ADD COLUMN "freeReplyCooldownMinutes" INTEGER NOT NULL DEFAULT 0;
