-- Free comments switch from monthly (5 low-rep / 15 established) to daily
-- (2 low-rep / 5 established) quotas. Existing monthly counters would strand
-- users at 0 free comments until their old monthly reset date; reset everyone
-- so the daily allowance starts fresh at cutover. Free posts stay monthly --
-- their counters are untouched.

UPDATE "users" SET "freeCommentCount" = 0, "freeCommentResetAt" = NULL;
