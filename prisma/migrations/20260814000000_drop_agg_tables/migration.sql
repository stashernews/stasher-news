-- A-12 remainder: drop the dead payin/payout aggregation tables and their
-- enum types. The leaderboard + user/turf stats were rewired to live
-- aggregation over ObservedTip/ObservedDownvote/FeeObservation/PayIn (topUsers
-- in api/resolvers/user.js, topSubs in api/resolvers/sub.js); nothing reads or
-- writes these tables anymore (verified by repo-wide grep).

DROP TABLE "AggPayIn";
DROP TABLE "AggPayOut";
DROP TYPE "AggGranularity";
DROP TYPE "AggSlice";
