-- StealthNews baseline migration (collapsed from 423 Stacker.news migrations).
-- PostgreSQL extensions required by the schema (Prisma does not manage these).
CREATE EXTENSION IF NOT EXISTS "ltree";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "ip4r";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateEnum
CREATE TYPE "OneDayReferralType" AS ENUM ('REFERRAL', 'POST', 'COMMENT', 'PROFILE', 'TERRITORY');

-- CreateEnum
CREATE TYPE "StreakType" AS ENUM ('COWBOY_HAT', 'GUN', 'HORSE');

-- CreateEnum
CREATE TYPE "NotificationIconType" AS ENUM ('MAP');

-- CreateEnum
CREATE TYPE "BillingType" AS ENUM ('MONTHLY', 'YEARLY', 'ONCE');

-- CreateEnum
CREATE TYPE "RankingType" AS ENUM ('WOT', 'RECENT');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'ACTIVE', 'HOLD', 'FAILED');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "DomainVerificationStage" AS ENUM ('GENERAL', 'CNAME', 'ACM_REQUEST_CERTIFICATE', 'ACM_REQUEST_VALIDATION_VALUES', 'ACM_VALIDATION', 'ELB_ATTACH_CERTIFICATE', 'VERIFICATION_COMPLETE');

-- CreateEnum
CREATE TYPE "DomainRecordType" AS ENUM ('CNAME', 'SSL');

-- CreateEnum
CREATE TYPE "DomainCertificateStatus" AS ENUM ('PENDING_VALIDATION', 'ISSUED', 'INACTIVE', 'EXPIRED', 'REVOKED', 'FAILED', 'VALIDATION_TIMED_OUT');

-- CreateEnum
CREATE TYPE "EarnType" AS ENUM ('POST', 'COMMENT', 'TIP_COMMENT', 'TIP_POST', 'FOREVER_REFERRAL', 'ONE_DAY_REFERRAL');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('ACTIVE', 'STOPPED', 'NOSATS', 'GRACE');

-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('LINK', 'DISCUSSION', 'JOB', 'POLL');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('OK', 'DEBUG', 'INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "PayInType" AS ENUM ('ITEM_CREATE', 'ITEM_UPDATE', 'ZAP', 'DOWN_ZAP', 'BOOST', 'DONATE', 'POLL_VOTE', 'TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'MEDIA_UPLOAD');

-- CreateEnum
CREATE TYPE "PayInState" AS ENUM ('PENDING_PAYMENT', 'DETECTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayInFailureReason" AS ENUM ('INVOICE_CREATION_FAILED', 'INVOICE_WRAPPING_FAILED_HIGH_PREDICTED_FEE', 'INVOICE_WRAPPING_FAILED_HIGH_PREDICTED_EXPIRY', 'INVOICE_WRAPPING_FAILED_UNKNOWN', 'INVOICE_FORWARDING_CLTV_DELTA_TOO_LOW', 'INVOICE_FORWARDING_FAILED', 'HELD_INVOICE_UNEXPECTED_ERROR', 'HELD_INVOICE_SETTLED_TOO_SLOW', 'WITHDRAWAL_FAILED', 'USER_CANCELLED', 'SYSTEM_CANCELLED', 'INVOICE_EXPIRED', 'EXECUTION_FAILED', 'UNKNOWN_FAILURE');

-- CreateEnum
CREATE TYPE "PayOutType" AS ENUM ('TERRITORY_REVENUE', 'REWARDS_POOL', 'ROUTING_FEE', 'ROUTING_FEE_REFUND', 'PROXY_PAYMENT', 'ZAP', 'BOUNTY_PAYMENT', 'REWARD', 'INVITE_GIFT', 'WITHDRAWAL', 'SYSTEM_REVENUE', 'BUY_CREDITS', 'INVOICE_OVERPAY_SPILLOVER', 'DEFUNCT_REFERRAL_ACT', 'DEFUNCT_DELAYED_TERRITORY_REVENUE');

-- CreateEnum
CREATE TYPE "AggGranularity" AS ENUM ('HOUR', 'DAY', 'MONTH');

-- CreateEnum
CREATE TYPE "AggSlice" AS ENUM ('GLOBAL', 'GLOBAL_BY_TYPE', 'SUB_TOTAL', 'SUB_BY_TYPE', 'USER_TOTAL', 'USER_BY_TYPE', 'SUB_BY_USER', 'USER_SUB_BY_TYPE');

-- CreateEnum
CREATE TYPE "Network" AS ENUM ('STAGENET', 'MAINNET');

-- CreateEnum
CREATE TYPE "PrivacyMode" AS ENUM ('AUTO_INDEX', 'MANUAL_PROOF');

-- CreateEnum
CREATE TYPE "LwsAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "SubaddressState" AS ENUM ('AVAILABLE', 'ASSIGNED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "ObservedState" AS ENUM ('DETECTED', 'CONFIRMED', 'REORGED');

-- CreateEnum
CREATE TYPE "ProofType" AS ENUM ('INDEXED', 'PROVEN');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'SENDING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutState" AS ENUM ('QUEUED', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "Snl" (
    "id" SERIAL NOT NULL,
    "live" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Snl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" CITEXT,
    "email" TEXT,
    "email_verified" TIMESTAMP(3),
    "emailHash" TEXT,
    "checkedNotesAt" TIMESTAMP(3),
    "foundNotesAt" TIMESTAMP(3),
    "apiKeyHash" CHAR(64),
    "apiKeyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tipRandomMin" INTEGER,
    "tipRandomMax" INTEGER,
    "bioId" INTEGER,
    "pubkey" TEXT,
    "inviteId" TEXT,
    "tipPopover" BOOLEAN NOT NULL DEFAULT false,
    "upvotePopover" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "stackedMsats" BIGINT NOT NULL DEFAULT 0,
    "stackedMcredits" BIGINT NOT NULL DEFAULT 0,
    "noteAllDescendants" BOOLEAN NOT NULL DEFAULT true,
    "noteDeposits" BOOLEAN NOT NULL DEFAULT true,
    "noteWithdrawals" BOOLEAN NOT NULL DEFAULT true,
    "noteEarning" BOOLEAN NOT NULL DEFAULT true,
    "noteInvites" BOOLEAN NOT NULL DEFAULT true,
    "noteItemSats" BOOLEAN NOT NULL DEFAULT true,
    "noteMentions" BOOLEAN NOT NULL DEFAULT true,
    "noteItemMentions" BOOLEAN NOT NULL DEFAULT true,
    "noteForwardedSats" BOOLEAN NOT NULL DEFAULT true,
    "photoId" INTEGER,
    "hideInvoiceDesc" BOOLEAN NOT NULL DEFAULT false,
    "postsSatsFilter" INTEGER DEFAULT 10,
    "commentsSatsFilter" INTEGER DEFAULT 1,
    "freeCommentCount" INTEGER NOT NULL DEFAULT 0,
    "freeCommentResetAt" TIMESTAMP(3),
    "nsfwMode" BOOLEAN NOT NULL DEFAULT false,
    "fiatCurrency" TEXT NOT NULL DEFAULT 'USD',
    "hideFromTopUsers" BOOLEAN NOT NULL DEFAULT false,
    "turboTipping" BOOLEAN NOT NULL DEFAULT false,
    "zapUndos" INTEGER,
    "imgproxyOnly" BOOLEAN NOT NULL DEFAULT false,
    "showImagesAndVideos" BOOLEAN NOT NULL DEFAULT true,
    "referrerId" INTEGER,
    "nostrPubkey" TEXT,
    "nostrAuthPubkey" TEXT,
    "nostrCrossposting" BOOLEAN NOT NULL DEFAULT false,
    "noteCowboyHat" BOOLEAN NOT NULL DEFAULT true,
    "streak" INTEGER,
    "gunStreak" INTEGER,
    "infected" BOOLEAN NOT NULL DEFAULT false,
    "cured" BOOLEAN NOT NULL DEFAULT false,
    "horseStreak" INTEGER,
    "subs" TEXT[],
    "hideCowboyHat" BOOLEAN NOT NULL DEFAULT false,
    "hideBookmarks" BOOLEAN NOT NULL DEFAULT false,
    "hideGithub" BOOLEAN NOT NULL DEFAULT true,
    "hideNostr" BOOLEAN NOT NULL DEFAULT true,
    "hideTwitter" BOOLEAN NOT NULL DEFAULT true,
    "noReferralLinks" BOOLEAN NOT NULL DEFAULT false,
    "githubId" TEXT,
    "twitterId" TEXT,
    "diagnostics" BOOLEAN NOT NULL DEFAULT false,
    "walletsUpdatedAt" TIMESTAMP(3),
    "moneroAddress" TEXT,
    "privacyMode" "PrivacyMode",
    "stackedPiconeros" BIGINT NOT NULL DEFAULT 0,
    "downvotePiconeros" BIGINT NOT NULL DEFAULT 0,
    "tipDefaultPiconeros" INTEGER NOT NULL DEFAULT 100000000,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Infection" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "infecteeId" INTEGER NOT NULL,
    "infectorId" INTEGER,

    CONSTRAINT "Infection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cure" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cureeId" INTEGER NOT NULL,
    "curerId" INTEGER,

    CONSTRAINT "Cure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneDayReferral" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referrerId" INTEGER NOT NULL,
    "refereeId" INTEGER NOT NULL,
    "type" "OneDayReferralType" NOT NULL,
    "typeId" TEXT NOT NULL,
    "landing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OneDayReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubTrust" (
    "subName" CITEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "zapPostTrust" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subZapPostTrust" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "zapCommentTrust" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subZapCommentTrust" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSubTrust_pkey" PRIMARY KEY ("userId","subName")
);

-- CreateTable
CREATE TABLE "Mute" (
    "muterId" INTEGER NOT NULL,
    "mutedId" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mute_pkey" PRIMARY KEY ("muterId","mutedId")
);

-- CreateTable
CREATE TABLE "Streak" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "userId" INTEGER NOT NULL,
    "type" "StreakType" NOT NULL DEFAULT 'COWBOY_HAT',

    CONSTRAINT "Streak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NostrRelay" (
    "addr" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NostrRelay_pkey" PRIMARY KEY ("addr")
);

-- CreateTable
CREATE TABLE "UserNostrRelay" (
    "userId" INTEGER NOT NULL,
    "nostrRelayAddr" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNostrRelay_pkey" PRIMARY KEY ("userId","nostrRelayAddr")
);

-- CreateTable
CREATE TABLE "ItemUpload" (
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "uploadId" INTEGER NOT NULL,

    CONSTRAINT "ItemUpload_pkey" PRIMARY KEY ("itemId","uploadId")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "userId" INTEGER NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Earn" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "msats" BIGINT NOT NULL,
    "userId" INTEGER NOT NULL,
    "rank" INTEGER,
    "typeProportion" DOUBLE PRECISION,
    "type" "EarnType",
    "typeId" INTEGER,

    CONSTRAINT "Earn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'::text),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "gift" INTEGER,
    "limit" INTEGER,
    "giftedCount" INTEGER NOT NULL DEFAULT 0,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT,
    "text" TEXT,
    "url" TEXT,
    "userId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "path" ltree,
    "pinId" INTEGER,
    "location" TEXT,
    "remote" BOOLEAN,
    "subNames" CITEXT[],
    "statusUpdatedAt" TIMESTAMP(3),
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "company" TEXT,
    "weightedVotes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subWeightedVotes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "boost" INTEGER NOT NULL DEFAULT 0,
    "pollCost" INTEGER,
    "commentMsats" BIGINT NOT NULL DEFAULT 0,
    "commentDownMsats" BIGINT NOT NULL DEFAULT 0,
    "commentMcredits" BIGINT NOT NULL DEFAULT 0,
    "commentCost" INTEGER NOT NULL DEFAULT 0,
    "commentBoost" INTEGER NOT NULL DEFAULT 0,
    "weightedComments" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastCommentAt" TIMESTAMP(3),
    "lastZapAt" TIMESTAMP(3),
    "ncomments" INTEGER NOT NULL DEFAULT 0,
    "nDirectComments" INTEGER NOT NULL DEFAULT 0,
    "msats" BIGINT NOT NULL DEFAULT 0,
    "downMsats" BIGINT NOT NULL DEFAULT 0,
    "mcredits" BIGINT NOT NULL DEFAULT 0,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "weightedDownVotes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subWeightedDownVotes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bio" BOOLEAN NOT NULL DEFAULT false,
    "freebie" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "otsFile" BYTEA,
    "otsHash" TEXT,
    "imgproxyUrls" JSONB,
    "noteId" TEXT,
    "rootId" INTEGER,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "uploadId" INTEGER,
    "netInvestment" INTEGER NOT NULL DEFAULT 0,
    "apiKey" BOOLEAN NOT NULL DEFAULT false,
    "pollExpiresAt" TIMESTAMP(3),
    "randPollOptions" BOOLEAN NOT NULL DEFAULT false,
    "ranktop" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "litCenteredSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "litCenteredAt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ranklit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subName" CITEXT,
    "subaddressIndexMajor" INTEGER,
    "subaddressIndexMinor" INTEGER,
    "subaddress" TEXT,
    "moneroAccountId" INTEGER,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationBulletin" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iconType" "NotificationIconType",
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "NotificationBulletin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemSub" (
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "subName" CITEXT NOT NULL,

    CONSTRAINT "ItemSub_pkey" PRIMARY KEY ("itemId","subName")
);

-- CreateTable
CREATE TABLE "ItemUserAgg" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "zapSats" BIGINT NOT NULL DEFAULT 0,
    "downZapSats" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ItemUserAgg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentsViewAt" (
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "last_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentsViewAt_pkey" PRIMARY KEY ("userId","itemId")
);

-- CreateTable
CREATE TABLE "AutoSocialPost" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,

    CONSTRAINT "AutoSocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reply" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ancestorId" INTEGER NOT NULL,
    "ancestorUserId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,

    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemForward" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "pct" INTEGER NOT NULL,

    CONSTRAINT "ItemForward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "option" TEXT NOT NULL,

    CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "pollOptionId" INTEGER NOT NULL,
    "payInId" INTEGER,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sub" (
    "name" CITEXT NOT NULL,
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "parentName" CITEXT,
    "path" ltree,
    "postTypes" "PostType"[],
    "rankingType" "RankingType" NOT NULL,
    "allowFreebies" BOOLEAN NOT NULL DEFAULT true,
    "baseCost" INTEGER NOT NULL DEFAULT 1,
    "replyCost" INTEGER NOT NULL DEFAULT 1,
    "desc" TEXT,
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "statusUpdatedAt" TIMESTAMP(3),
    "billingType" "BillingType" NOT NULL,
    "billingCost" INTEGER NOT NULL,
    "billingAutoRenew" BOOLEAN NOT NULL DEFAULT false,
    "billedLastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billPaidUntil" TIMESTAMP(3),
    "postsSatsFilter" INTEGER NOT NULL DEFAULT 10,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "moneroAddress" TEXT,

    CONSTRAINT "Sub_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "SubBranding" (
    "subName" CITEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "linkColor" TEXT,
    "logoId" INTEGER,
    "title" TEXT,
    "tagline" TEXT,
    "faviconId" INTEGER,

    CONSTRAINT "SubBranding_pkey" PRIMARY KEY ("subName")
);

-- CreateTable
CREATE TABLE "MuteSub" (
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subName" CITEXT NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "MuteSub_pkey" PRIMARY KEY ("userId","subName")
);

-- CreateTable
CREATE TABLE "Pin" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cron" TEXT,
    "timezone" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Pin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "Mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemMention" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referrerId" INTEGER NOT NULL,
    "refereeId" INTEGER NOT NULL,

    CONSTRAINT "ItemMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" INTEGER NOT NULL,
    "provider_type" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "access_token_expires" TEXT,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "oauth_token" TEXT,
    "oauth_token_secret" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OFAC" (
    "id" SERIAL NOT NULL,
    "startIP" ipaddress NOT NULL,
    "endIP" ipaddress NOT NULL,
    "country" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "OFAC_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" SERIAL NOT NULL,
    "session_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" INTEGER NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_requests" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("userId","itemId")
);

-- CreateTable
CREATE TABLE "ThreadSubscription" (
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadSubscription_pkey" PRIMARY KEY ("userId","itemId")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "followerId" INTEGER NOT NULL,
    "followeeId" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postsSubscribedAt" TIMESTAMP(3),
    "commentsSubscribedAt" TIMESTAMP(3),

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("followerId","followeeId")
);

-- CreateTable
CREATE TABLE "SubSubscription" (
    "userId" INTEGER NOT NULL,
    "subName" CITEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubSubscription_pkey" PRIMARY KEY ("userId","subName")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryTransfer" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "oldUserId" INTEGER NOT NULL,
    "newUserId" INTEGER NOT NULL,
    "subName" CITEXT NOT NULL,

    CONSTRAINT "TerritoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domainName" CITEXT NOT NULL,
    "subName" CITEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainAuthRequest" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domainId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainVerificationAttempt" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domainId" INTEGER NOT NULL,
    "verificationRecordId" INTEGER,
    "stage" "DomainVerificationStage" NOT NULL DEFAULT 'GENERAL',
    "status" "RecordStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,

    CONSTRAINT "DomainVerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainVerificationRecord" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMP(3),
    "domainId" INTEGER NOT NULL,
    "type" "DomainRecordType" NOT NULL,
    "recordName" TEXT NOT NULL,
    "recordValue" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "DomainVerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainCertificate" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domainId" INTEGER NOT NULL,
    "certificateArn" TEXT NOT NULL,
    "status" "DomainCertificateStatus" NOT NULL,

    CONSTRAINT "DomainCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemPayIn" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "payInId" INTEGER NOT NULL,

    CONSTRAINT "ItemPayIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubPayIn" (
    "id" SERIAL NOT NULL,
    "subName" CITEXT NOT NULL,
    "payInId" INTEGER NOT NULL,

    CONSTRAINT "SubPayIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadPayIn" (
    "id" SERIAL NOT NULL,
    "uploadId" INTEGER NOT NULL,
    "payInId" INTEGER NOT NULL,

    CONSTRAINT "UploadPayIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayIn" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mcost" BIGINT NOT NULL,
    "payInType" "PayInType" NOT NULL,
    "payInState" "PayInState" NOT NULL,
    "payInFailureReason" "PayInFailureReason",
    "payInStateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "genesisId" INTEGER,
    "successorId" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "benefactorId" INTEGER,
    "userId" INTEGER NOT NULL,
    "moneroUri" TEXT,
    "observedTipId" BIGINT,
    "observedBurnId" BIGINT,

    CONSTRAINT "PayIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggPayIn" (
    "id" SERIAL NOT NULL,
    "timeBucket" TIMESTAMPTZ(3) NOT NULL,
    "granularity" "AggGranularity" NOT NULL,
    "payInType" "PayInType",
    "subId" INTEGER,
    "userId" INTEGER,
    "sumMcost" BIGINT NOT NULL,
    "countUsers" BIGINT NOT NULL,
    "countGroup" BIGINT NOT NULL,
    "slice" "AggSlice" NOT NULL,

    CONSTRAINT "AggPayIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggPayOut" (
    "id" SERIAL NOT NULL,
    "timeBucket" TIMESTAMPTZ(3) NOT NULL,
    "granularity" "AggGranularity" NOT NULL,
    "payOutType" "PayOutType",
    "payInType" "PayInType",
    "subId" INTEGER,
    "userId" INTEGER,
    "sumMtokens" BIGINT NOT NULL,
    "countUsers" BIGINT NOT NULL,
    "countGroup" BIGINT NOT NULL,
    "slice" "AggSlice" NOT NULL,

    CONSTRAINT "AggPayOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggRegistrations" (
    "id" SERIAL NOT NULL,
    "timeBucket" TIMESTAMPTZ(3) NOT NULL,
    "granularity" "AggGranularity" NOT NULL,
    "count" BIGINT NOT NULL,
    "invitedCount" BIGINT NOT NULL,
    "referredCount" BIGINT NOT NULL,

    CONSTRAINT "AggRegistrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggRewards" (
    "id" SERIAL NOT NULL,
    "timeBucket" TIMESTAMPTZ(3) NOT NULL,
    "granularity" "AggGranularity" NOT NULL,
    "payInType" "PayInType",
    "msats" BIGINT NOT NULL,
    "countGroup" BIGINT NOT NULL,

    CONSTRAINT "AggRewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneroAccount" (
    "id" SERIAL NOT NULL,
    "ownerUserId" INTEGER,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "scanFromHeight" BIGINT NOT NULL DEFAULT 0,
    "lastTxId" BIGINT NOT NULL DEFAULT 0,
    "lastBlockHash" TEXT,
    "status" "LwsAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lwsRegisteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneroAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneroViewKey" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "dekVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "MoneroViewKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubaddressIndex" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "majorIndex" INTEGER NOT NULL,
    "minorIndex" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "state" "SubaddressState" NOT NULL DEFAULT 'AVAILABLE',
    "assignedPostId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubaddressIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservedTip" (
    "id" BIGSERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "tipperId" INTEGER,
    "recipientAccountId" INTEGER NOT NULL,
    "recipientMajor" INTEGER NOT NULL,
    "recipientMinor" INTEGER NOT NULL,
    "paymentId" TEXT,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "ObservedState" NOT NULL DEFAULT 'DETECTED',
    "proofType" "ProofType" NOT NULL DEFAULT 'INDEXED',
    "txPrivateKey" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ObservedTip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservedBurn" (
    "id" BIGSERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "downvoterId" INTEGER,
    "paymentId" TEXT NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "height" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "state" "ObservedState" NOT NULL DEFAULT 'DETECTED',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ObservedBurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardDistribution" (
    "id" SERIAL NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "poolPiconeros" BIGINT NOT NULL,
    "distributedPiconeros" BIGINT NOT NULL DEFAULT 0,
    "rolledOverPiconeros" BIGINT NOT NULL DEFAULT 0,
    "payoutCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DistributionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RewardDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardPayout" (
    "id" SERIAL NOT NULL,
    "distributionId" INTEGER NOT NULL,
    "curatorId" INTEGER NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "piconeros" BIGINT NOT NULL,
    "txHash" TEXT,
    "state" "PayoutState" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownvotePidMap" (
    "paymentId" TEXT NOT NULL,
    "postId" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "DownvotePidMap_pkey" PRIMARY KEY ("paymentId")
);

-- CreateTable
CREATE TABLE "PlatformFeeConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "requiredConfirmations" INTEGER NOT NULL DEFAULT 10,
    "minTipPiconeros" BIGINT NOT NULL DEFAULT 100000000,
    "defaultDownvotePiconeros" BIGINT NOT NULL DEFAULT 1000000000,
    "downvoteMinPiconeros" BIGINT NOT NULL DEFAULT 100000000,
    "freePostThresholdPiconeros" BIGINT NOT NULL DEFAULT 10000000000,
    "freePostMinAgeDays" INTEGER NOT NULL DEFAULT 7,
    "postingFeeFloorPiconeros" BIGINT NOT NULL DEFAULT 1000000000,
    "territoryMonthlyPiconeros" BIGINT NOT NULL DEFAULT 200000000000,
    "territoryYearlyPiconeros" BIGINT NOT NULL DEFAULT 2000000000000,
    "territoryOncePiconeros" BIGINT NOT NULL DEFAULT 10000000000000,
    "downvoteRewardsPct" INTEGER NOT NULL DEFAULT 100,
    "postingFeeRewardsPct" INTEGER NOT NULL DEFAULT 70,
    "territoryFeeRewardsPct" INTEGER NOT NULL DEFAULT 30,
    "distributionTopN" INTEGER NOT NULL DEFAULT 100,
    "distributionMinPayoutPiconeros" BIGINT NOT NULL DEFAULT 1000000000,

    CONSTRAINT "PlatformFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users.name_unique" ON "users"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users.email_unique" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users.email_hash_unique" ON "users"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "users.apikeyhash_unique" ON "users"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "users.pubkey_unique" ON "users"("pubkey");

-- CreateIndex
CREATE UNIQUE INDEX "users.nostrAuthPubkey_unique" ON "users"("nostrAuthPubkey");

-- CreateIndex
CREATE INDEX "users_photoId_idx" ON "users"("photoId");

-- CreateIndex
CREATE INDEX "users.created_at_index" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "users.inviteId_index" ON "users"("inviteId");

-- CreateIndex
CREATE INDEX "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_streak_idx" ON "users"("streak");

-- CreateIndex
CREATE INDEX "users_gunStreak_idx" ON "users"("gunStreak");

-- CreateIndex
CREATE INDEX "users_horseStreak_idx" ON "users"("horseStreak");

-- CreateIndex
CREATE UNIQUE INDEX "Infection_infecteeId_unique" ON "Infection"("infecteeId");

-- CreateIndex
CREATE INDEX "Infection_infectorId_idx" ON "Infection"("infectorId");

-- CreateIndex
CREATE UNIQUE INDEX "Cure_cureeId_unique" ON "Cure"("cureeId");

-- CreateIndex
CREATE INDEX "Cure_curerId_idx" ON "Cure"("curerId");

-- CreateIndex
CREATE INDEX "OneDayReferral_created_at_idx" ON "OneDayReferral"("created_at");

-- CreateIndex
CREATE INDEX "OneDayReferral_referrerId_idx" ON "OneDayReferral"("referrerId");

-- CreateIndex
CREATE INDEX "OneDayReferral_refereeId_idx" ON "OneDayReferral"("refereeId");

-- CreateIndex
CREATE INDEX "OneDayReferral_type_typeId_idx" ON "OneDayReferral"("type", "typeId");

-- CreateIndex
CREATE INDEX "UserSubTrust_subName_idx" ON "UserSubTrust"("subName");

-- CreateIndex
CREATE INDEX "Mute_mutedId_muterId_idx" ON "Mute"("mutedId", "muterId");

-- CreateIndex
CREATE INDEX "Streak.userId_index" ON "Streak"("userId");

-- CreateIndex
CREATE INDEX "Streak_type_idx" ON "Streak"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Streak_startedAt_userId_type_key" ON "Streak"("startedAt", "userId", "type");

-- CreateIndex
CREATE INDEX "ItemUpload_created_at_idx" ON "ItemUpload"("created_at");

-- CreateIndex
CREATE INDEX "ItemUpload_itemId_idx" ON "ItemUpload"("itemId");

-- CreateIndex
CREATE INDEX "ItemUpload_uploadId_idx" ON "ItemUpload"("uploadId");

-- CreateIndex
CREATE INDEX "Upload.created_at_index" ON "Upload"("created_at");

-- CreateIndex
CREATE INDEX "Upload.userId_index" ON "Upload"("userId");

-- CreateIndex
CREATE INDEX "Earn.created_at_index" ON "Earn"("created_at");

-- CreateIndex
CREATE INDEX "Earn.created_at_userId_index" ON "Earn"("created_at", "userId");

-- CreateIndex
CREATE INDEX "Earn.userId_index" ON "Earn"("userId");

-- CreateIndex
CREATE INDEX "Invite.created_at_index" ON "Invite"("created_at");

-- CreateIndex
CREATE INDEX "Invite.userId_index" ON "Invite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Item.noteId_unique" ON "Item"("noteId");

-- CreateIndex
CREATE INDEX "Item_uploadId_idx" ON "Item"("uploadId");

-- CreateIndex
CREATE INDEX "Item_lastZapAt_idx" ON "Item"("lastZapAt");

-- CreateIndex
CREATE INDEX "Item.bio_index" ON "Item"("bio");

-- CreateIndex
CREATE INDEX "Item.created_at_index" ON "Item"("created_at");

-- CreateIndex
CREATE INDEX "Item.freebie_index" ON "Item"("freebie");

-- CreateIndex
CREATE INDEX "Item.parentId_index" ON "Item"("parentId");

-- CreateIndex
CREATE INDEX "Item.path_index" ON "Item" USING GIST ("path");

-- CreateIndex
CREATE INDEX "Item.path_index0" ON "Item" USING GIST ("path");

-- CreateIndex
CREATE INDEX "Item.pinId_index" ON "Item"("pinId");

-- CreateIndex
CREATE INDEX "Item.rootId_index" ON "Item"("rootId");

-- CreateIndex
CREATE INDEX "Item.statusUpdatedAt_index" ON "Item"("statusUpdatedAt");

-- CreateIndex
CREATE INDEX "Item.status_index" ON "Item"("status");

-- CreateIndex
CREATE INDEX "Item_subNames_idx" ON "Item" USING GIN ("subNames");

-- CreateIndex
CREATE INDEX "Item_subNames_created_at_idx" ON "Item" USING GIN ("subNames", "created_at" timestamp_ops);

-- CreateIndex
CREATE INDEX "Item_subNames_ranktop_idx" ON "Item" USING GIN ("subNames", "ranktop" float8_ops);

-- CreateIndex
CREATE INDEX "Item_subNames_ranklit_idx" ON "Item" USING GIN ("subNames", "ranklit" float8_ops);

-- CreateIndex
CREATE INDEX "Item_subNames_downMsats_idx" ON "Item" USING GIN ("subNames", "downMsats" int8_ops);

-- CreateIndex
CREATE INDEX "Item_subNames_ncomments_idx" ON "Item" USING GIN ("subNames", "ncomments" int4_ops);

-- CreateIndex
CREATE INDEX "Item.userId_index" ON "Item"("userId");

-- CreateIndex
CREATE INDEX "Item.weightedDownVotes_index" ON "Item"("weightedDownVotes");

-- CreateIndex
CREATE INDEX "Item.weightedVotes_index" ON "Item"("weightedVotes");

-- CreateIndex
CREATE INDEX "Item_cost_idx" ON "Item"("cost");

-- CreateIndex
CREATE INDEX "Item_url_trgm_idx" ON "Item" USING GIN ("url" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Item_boost_idx" ON "Item"("boost");

-- CreateIndex
CREATE INDEX "Item_ranktop_idx" ON "Item"("ranktop");

-- CreateIndex
CREATE INDEX "Item_ranklit_idx" ON "Item"("ranklit");

-- CreateIndex
CREATE INDEX "Item_netInvestment_idx" ON "Item"("netInvestment");

-- CreateIndex
CREATE INDEX "Item_downMsats_idx" ON "Item"("downMsats");

-- CreateIndex
CREATE INDEX "Item_ncomments_idx" ON "Item"("ncomments");

-- CreateIndex
CREATE INDEX "Item_userId_created_at_idx" ON "Item"("userId", "created_at");

-- CreateIndex
CREATE INDEX "Item_userId_ranktop_idx" ON "Item"("userId", "ranktop");

-- CreateIndex
CREATE INDEX "Item_userId_downMsats_idx" ON "Item"("userId", "downMsats");

-- CreateIndex
CREATE INDEX "Item_userId_ncomments_idx" ON "Item"("userId", "ncomments");

-- CreateIndex
CREATE INDEX "NotificationBulletin_created_at_idx" ON "NotificationBulletin"("created_at");

-- CreateIndex
CREATE INDEX "ItemSub_itemId_idx" ON "ItemSub"("itemId");

-- CreateIndex
CREATE INDEX "ItemSub_subName_idx" ON "ItemSub"("subName");

-- CreateIndex
CREATE INDEX "ItemSub_created_at_idx" ON "ItemSub"("created_at");

-- CreateIndex
CREATE INDEX "ItemUserAgg_itemId_idx" ON "ItemUserAgg"("itemId");

-- CreateIndex
CREATE INDEX "ItemUserAgg_userId_idx" ON "ItemUserAgg"("userId");

-- CreateIndex
CREATE INDEX "ItemUserAgg_created_at_idx" ON "ItemUserAgg"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ItemUserAgg_itemId_userId_key" ON "ItemUserAgg"("itemId", "userId");

-- CreateIndex
CREATE INDEX "CommentsViewAt_userId_idx" ON "CommentsViewAt"("userId");

-- CreateIndex
CREATE INDEX "AutoSocialPost_itemId_idx" ON "AutoSocialPost"("itemId");

-- CreateIndex
CREATE INDEX "AutoSocialPost_created_at_idx" ON "AutoSocialPost"("created_at");

-- CreateIndex
CREATE INDEX "Reply_ancestorId_idx" ON "Reply"("ancestorId");

-- CreateIndex
CREATE INDEX "Reply_ancestorUserId_idx" ON "Reply"("ancestorUserId");

-- CreateIndex
CREATE INDEX "Reply_itemId_idx" ON "Reply"("itemId");

-- CreateIndex
CREATE INDEX "Reply_userId_idx" ON "Reply"("userId");

-- CreateIndex
CREATE INDEX "Reply_level_idx" ON "Reply"("level");

-- CreateIndex
CREATE INDEX "Reply_created_at_idx" ON "Reply"("created_at");

-- CreateIndex
CREATE INDEX "ItemForward.itemId_index" ON "ItemForward"("itemId");

-- CreateIndex
CREATE INDEX "ItemForward.userId_index" ON "ItemForward"("userId");

-- CreateIndex
CREATE INDEX "ItemForward.createdAt_index" ON "ItemForward"("created_at");

-- CreateIndex
CREATE INDEX "PollOption.itemId_index" ON "PollOption"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "PollVote_payInId_key" ON "PollVote"("payInId");

-- CreateIndex
CREATE INDEX "PollVote.pollOptionId_index" ON "PollVote"("pollOptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Sub_id_key" ON "Sub"("id");

-- CreateIndex
CREATE INDEX "Sub_parentName_idx" ON "Sub"("parentName");

-- CreateIndex
CREATE INDEX "Sub_created_at_idx" ON "Sub"("created_at");

-- CreateIndex
CREATE INDEX "Sub_userId_idx" ON "Sub"("userId");

-- CreateIndex
CREATE INDEX "Sub_statusUpdatedAt_idx" ON "Sub"("statusUpdatedAt");

-- CreateIndex
CREATE INDEX "Sub_path_idx" ON "Sub" USING GIST ("path");

-- CreateIndex
CREATE INDEX "SubBranding_logoId_idx" ON "SubBranding"("logoId");

-- CreateIndex
CREATE INDEX "SubBranding_faviconId_idx" ON "SubBranding"("faviconId");

-- CreateIndex
CREATE INDEX "MuteSub_subName_idx" ON "MuteSub"("subName");

-- CreateIndex
CREATE INDEX "MuteSub_created_at_idx" ON "MuteSub"("created_at");

-- CreateIndex
CREATE INDEX "Mention.created_at_index" ON "Mention"("created_at");

-- CreateIndex
CREATE INDEX "Mention.itemId_index" ON "Mention"("itemId");

-- CreateIndex
CREATE INDEX "Mention.userId_index" ON "Mention"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Mention.itemId_userId_unique" ON "Mention"("itemId", "userId");

-- CreateIndex
CREATE INDEX "ItemMention.created_at_index" ON "ItemMention"("created_at");

-- CreateIndex
CREATE INDEX "ItemMention.referrerId_index" ON "ItemMention"("referrerId");

-- CreateIndex
CREATE INDEX "ItemMention.refereeId_index" ON "ItemMention"("refereeId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemMention.referrerId_refereeId_unique" ON "ItemMention"("referrerId", "refereeId");

-- CreateIndex
CREATE INDEX "accounts.user_id_index" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_provider_account_id_key" ON "accounts"("provider_id", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions.session_token_unique" ON "sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_requests.token_unique" ON "verification_requests"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_requests_identifier_token_key" ON "verification_requests"("identifier", "token");

-- CreateIndex
CREATE INDEX "Bookmark.created_at_index" ON "Bookmark"("created_at");

-- CreateIndex
CREATE INDEX "ThreadSubscription.created_at_index" ON "ThreadSubscription"("created_at");

-- CreateIndex
CREATE INDEX "UserSubscription.created_at_index" ON "UserSubscription"("created_at");

-- CreateIndex
CREATE INDEX "UserSubscription.follower_index" ON "UserSubscription"("followerId");

-- CreateIndex
CREATE INDEX "UserSubscription.followee_index" ON "UserSubscription"("followeeId");

-- CreateIndex
CREATE INDEX "SubSubscription.created_at_index" ON "SubSubscription"("created_at");

-- CreateIndex
CREATE INDEX "SubSubscription_subName_idx" ON "SubSubscription"("subName");

-- CreateIndex
CREATE INDEX "PushSubscription.userId_index" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "TerritoryTransfer.newUserId_index" ON "TerritoryTransfer"("created_at", "newUserId");

-- CreateIndex
CREATE INDEX "TerritoryTransfer.oldUserId_index" ON "TerritoryTransfer"("created_at", "oldUserId");

-- CreateIndex
CREATE INDEX "TerritoryTransfer_subName_idx" ON "TerritoryTransfer"("subName");

-- CreateIndex
CREATE INDEX "Reminder.userId_reminderAt_index" ON "Reminder"("userId", "remindAt");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_domainName_key" ON "Domain"("domainName");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_subName_key" ON "Domain"("subName");

-- CreateIndex
CREATE INDEX "Domain_created_at_idx" ON "Domain"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "DomainAuthRequest_code_key" ON "DomainAuthRequest"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DomainAuthRequest_challenge_key" ON "DomainAuthRequest"("challenge");

-- CreateIndex
CREATE INDEX "DomainAuthRequest_domainId_idx" ON "DomainAuthRequest"("domainId");

-- CreateIndex
CREATE INDEX "DomainAuthRequest_userId_idx" ON "DomainAuthRequest"("userId");

-- CreateIndex
CREATE INDEX "DomainVerificationAttempt_domainId_idx" ON "DomainVerificationAttempt"("domainId");

-- CreateIndex
CREATE INDEX "DomainVerificationAttempt_verificationRecordId_idx" ON "DomainVerificationAttempt"("verificationRecordId");

-- CreateIndex
CREATE INDEX "DomainVerificationRecord_domainId_idx" ON "DomainVerificationRecord"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainVerificationRecord_domainId_type_recordName_key" ON "DomainVerificationRecord"("domainId", "type", "recordName");

-- CreateIndex
CREATE UNIQUE INDEX "DomainCertificate_certificateArn_key" ON "DomainCertificate"("certificateArn");

-- CreateIndex
CREATE UNIQUE INDEX "DomainCertificate_domainId_key" ON "DomainCertificate"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemPayIn_payInId_key" ON "ItemPayIn"("payInId");

-- CreateIndex
CREATE INDEX "ItemPayIn_itemId_idx" ON "ItemPayIn"("itemId");

-- CreateIndex
CREATE INDEX "ItemPayIn_itemId_payInId_idx" ON "ItemPayIn"("itemId", "payInId");

-- CreateIndex
CREATE UNIQUE INDEX "SubPayIn_payInId_key" ON "SubPayIn"("payInId");

-- CreateIndex
CREATE INDEX "SubPayIn_subName_idx" ON "SubPayIn"("subName");

-- CreateIndex
CREATE INDEX "UploadPayIn_uploadId_idx" ON "UploadPayIn"("uploadId");

-- CreateIndex
CREATE INDEX "UploadPayIn_payInId_idx" ON "UploadPayIn"("payInId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadPayIn_uploadId_payInId_key" ON "UploadPayIn"("uploadId", "payInId");

-- CreateIndex
CREATE UNIQUE INDEX "PayIn_successorId_key" ON "PayIn"("successorId");

-- CreateIndex
CREATE INDEX "PayIn_userId_idx" ON "PayIn"("userId");

-- CreateIndex
CREATE INDEX "PayIn_created_at_idx" ON "PayIn"("created_at");

-- CreateIndex
CREATE INDEX "PayIn_payInType_idx" ON "PayIn"("payInType");

-- CreateIndex
CREATE INDEX "PayIn_genesisId_idx" ON "PayIn"("genesisId");

-- CreateIndex
CREATE INDEX "PayIn_payInState_idx" ON "PayIn"("payInState");

-- CreateIndex
CREATE INDEX "PayIn_benefactorId_idx" ON "PayIn"("benefactorId");

-- CreateIndex
CREATE INDEX "PayIn_payInStateChangedAt_idx" ON "PayIn"("payInStateChangedAt");

-- CreateIndex
CREATE INDEX "PayIn_userId_payInState_payInStateChangedAt_payInType_idx" ON "PayIn"("userId", "payInState", "payInStateChangedAt", "payInType");

-- CreateIndex
CREATE INDEX "PayIn_id_payInType_payInState_userId_idx" ON "PayIn"("id", "payInType", "payInState", "userId");

-- CreateIndex
CREATE INDEX "AggPayIn_granularity_slice_timeBucket_idx" ON "AggPayIn"("granularity", "slice", "timeBucket");

-- CreateIndex
CREATE INDEX "AggPayIn_growth_user_idx" ON "AggPayIn"("granularity", "slice", "userId", "timeBucket", "payInType");

-- CreateIndex
CREATE INDEX "AggPayIn_growth_sub_idx" ON "AggPayIn"("granularity", "slice", "subId", "timeBucket", "payInType");

-- CreateIndex
CREATE INDEX "AggPayIn_granularity_timeBucket_idx" ON "AggPayIn"("granularity", "timeBucket");

-- CreateIndex
CREATE INDEX "AggPayIn_granularity_payInType_idx" ON "AggPayIn"("granularity", "payInType");

-- CreateIndex
CREATE INDEX "AggPayIn_granularity_subId_idx" ON "AggPayIn"("granularity", "subId");

-- CreateIndex
CREATE INDEX "AggPayIn_granularity_userId_idx" ON "AggPayIn"("granularity", "userId");

-- CreateIndex
CREATE INDEX "AggPayIn_subId_idx" ON "AggPayIn"("subId");

-- CreateIndex
CREATE UNIQUE INDEX "AggPayIn_unique_key" ON "AggPayIn"("granularity", "timeBucket", "payInType", "subId", "userId", "slice");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_slice_timeBucket_idx" ON "AggPayOut"("granularity", "slice", "timeBucket");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_timeBucket_idx" ON "AggPayOut"("granularity", "timeBucket");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_payInType_idx" ON "AggPayOut"("granularity", "payInType");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_payOutType_idx" ON "AggPayOut"("granularity", "payOutType");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_subId_idx" ON "AggPayOut"("granularity", "subId");

-- CreateIndex
CREATE INDEX "AggPayOut_granularity_userId_idx" ON "AggPayOut"("granularity", "userId");

-- CreateIndex
CREATE INDEX "AggPayOut_subId_idx" ON "AggPayOut"("subId");

-- CreateIndex
CREATE UNIQUE INDEX "AggPayOut_unique_key" ON "AggPayOut"("granularity", "timeBucket", "payOutType", "payInType", "subId", "userId", "slice");

-- CreateIndex
CREATE UNIQUE INDEX "AggRegistrations_unique_key" ON "AggRegistrations"("granularity", "timeBucket");

-- CreateIndex
CREATE UNIQUE INDEX "AggRewards_unique_key" ON "AggRewards"("granularity", "timeBucket", "payInType");

-- CreateIndex
CREATE INDEX "MoneroAccount_ownerUserId_idx" ON "MoneroAccount"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MoneroAccount_address_network_key" ON "MoneroAccount"("address", "network");

-- CreateIndex
CREATE UNIQUE INDEX "MoneroViewKey_accountId_key" ON "MoneroViewKey"("accountId");

-- CreateIndex
CREATE INDEX "SubaddressIndex_accountId_state_idx" ON "SubaddressIndex"("accountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SubaddressIndex_accountId_majorIndex_minorIndex_key" ON "SubaddressIndex"("accountId", "majorIndex", "minorIndex");

-- CreateIndex
CREATE INDEX "ObservedTip_postId_idx" ON "ObservedTip"("postId");

-- CreateIndex
CREATE INDEX "ObservedTip_state_idx" ON "ObservedTip"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedTip_txHash_recipientAccountId_recipientMajor_recipi_key" ON "ObservedTip"("txHash", "recipientAccountId", "recipientMajor", "recipientMinor");

-- CreateIndex
CREATE INDEX "ObservedBurn_postId_idx" ON "ObservedBurn"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedBurn_txHash_paymentId_key" ON "ObservedBurn"("txHash", "paymentId");

-- CreateIndex
CREATE INDEX "RewardPayout_distributionId_idx" ON "RewardPayout"("distributionId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_bioId_fkey" FOREIGN KEY ("bioId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Infection" ADD CONSTRAINT "Infection_infecteeId_fkey" FOREIGN KEY ("infecteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Infection" ADD CONSTRAINT "Infection_infectorId_fkey" FOREIGN KEY ("infectorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cure" ADD CONSTRAINT "Cure_cureeId_fkey" FOREIGN KEY ("cureeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cure" ADD CONSTRAINT "Cure_curerId_fkey" FOREIGN KEY ("curerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneDayReferral" ADD CONSTRAINT "OneDayReferral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneDayReferral" ADD CONSTRAINT "OneDayReferral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubTrust" ADD CONSTRAINT "UserSubTrust_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubTrust" ADD CONSTRAINT "UserSubTrust_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mute" ADD CONSTRAINT "Mute_muterId_fkey" FOREIGN KEY ("muterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mute" ADD CONSTRAINT "Mute_mutedId_fkey" FOREIGN KEY ("mutedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Streak" ADD CONSTRAINT "Streak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNostrRelay" ADD CONSTRAINT "UserNostrRelay_nostrRelayAddr_fkey" FOREIGN KEY ("nostrRelayAddr") REFERENCES "NostrRelay"("addr") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNostrRelay" ADD CONSTRAINT "UserNostrRelay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUpload" ADD CONSTRAINT "ItemUpload_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUpload" ADD CONSTRAINT "ItemUpload_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Earn" ADD CONSTRAINT "Earn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_moneroAccountId_fkey" FOREIGN KEY ("moneroAccountId") REFERENCES "MoneroAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_pinId_fkey" FOREIGN KEY ("pinId") REFERENCES "Pin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSub" ADD CONSTRAINT "ItemSub_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSub" ADD CONSTRAINT "ItemSub_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUserAgg" ADD CONSTRAINT "ItemUserAgg_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUserAgg" ADD CONSTRAINT "ItemUserAgg_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentsViewAt" ADD CONSTRAINT "CommentsViewAt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentsViewAt" ADD CONSTRAINT "CommentsViewAt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoSocialPost" ADD CONSTRAINT "AutoSocialPost_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_ancestorUserId_fkey" FOREIGN KEY ("ancestorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_ancestorId_fkey" FOREIGN KEY ("ancestorId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemForward" ADD CONSTRAINT "ItemForward_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemForward" ADD CONSTRAINT "ItemForward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_pollOptionId_fkey" FOREIGN KEY ("pollOptionId") REFERENCES "PollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sub" ADD CONSTRAINT "Sub_parentName_fkey" FOREIGN KEY ("parentName") REFERENCES "Sub"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sub" ADD CONSTRAINT "Sub_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubBranding" ADD CONSTRAINT "SubBranding_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubBranding" ADD CONSTRAINT "SubBranding_logoId_fkey" FOREIGN KEY ("logoId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubBranding" ADD CONSTRAINT "SubBranding_faviconId_fkey" FOREIGN KEY ("faviconId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MuteSub" ADD CONSTRAINT "MuteSub_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MuteSub" ADD CONSTRAINT "MuteSub_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemMention" ADD CONSTRAINT "ItemMention_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemMention" ADD CONSTRAINT "ItemMention_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadSubscription" ADD CONSTRAINT "ThreadSubscription_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadSubscription" ADD CONSTRAINT "ThreadSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubSubscription" ADD CONSTRAINT "SubSubscription_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubSubscription" ADD CONSTRAINT "SubSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryTransfer" ADD CONSTRAINT "TerritoryTransfer_oldUserId_fkey" FOREIGN KEY ("oldUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryTransfer" ADD CONSTRAINT "TerritoryTransfer_newUserId_fkey" FOREIGN KEY ("newUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryTransfer" ADD CONSTRAINT "TerritoryTransfer_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAuthRequest" ADD CONSTRAINT "DomainAuthRequest_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAuthRequest" ADD CONSTRAINT "DomainAuthRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainVerificationAttempt" ADD CONSTRAINT "DomainVerificationAttempt_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainVerificationAttempt" ADD CONSTRAINT "DomainVerificationAttempt_verificationRecordId_fkey" FOREIGN KEY ("verificationRecordId") REFERENCES "DomainVerificationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainVerificationRecord" ADD CONSTRAINT "DomainVerificationRecord_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainCertificate" ADD CONSTRAINT "DomainCertificate_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemPayIn" ADD CONSTRAINT "ItemPayIn_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemPayIn" ADD CONSTRAINT "ItemPayIn_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubPayIn" ADD CONSTRAINT "SubPayIn_subName_fkey" FOREIGN KEY ("subName") REFERENCES "Sub"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubPayIn" ADD CONSTRAINT "SubPayIn_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadPayIn" ADD CONSTRAINT "UploadPayIn_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadPayIn" ADD CONSTRAINT "UploadPayIn_payInId_fkey" FOREIGN KEY ("payInId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayIn" ADD CONSTRAINT "PayIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayIn" ADD CONSTRAINT "PayIn_genesisId_fkey" FOREIGN KEY ("genesisId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayIn" ADD CONSTRAINT "PayIn_successorId_fkey" FOREIGN KEY ("successorId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayIn" ADD CONSTRAINT "PayIn_benefactorId_fkey" FOREIGN KEY ("benefactorId") REFERENCES "PayIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggPayIn" ADD CONSTRAINT "AggPayIn_subId_fkey" FOREIGN KEY ("subId") REFERENCES "Sub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggPayOut" ADD CONSTRAINT "AggPayOut_subId_fkey" FOREIGN KEY ("subId") REFERENCES "Sub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneroAccount" ADD CONSTRAINT "MoneroAccount_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneroViewKey" ADD CONSTRAINT "MoneroViewKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneroAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubaddressIndex" ADD CONSTRAINT "SubaddressIndex_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneroAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubaddressIndex" ADD CONSTRAINT "SubaddressIndex_assignedPostId_fkey" FOREIGN KEY ("assignedPostId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservedTip" ADD CONSTRAINT "ObservedTip_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservedTip" ADD CONSTRAINT "ObservedTip_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "MoneroAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservedBurn" ADD CONSTRAINT "ObservedBurn_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardPayout" ADD CONSTRAINT "RewardPayout_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "RewardDistribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardPayout" ADD CONSTRAINT "RewardPayout_curatorId_fkey" FOREIGN KEY ("curatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Item ranking trigger (reproduced verbatim from migration
-- 20260209000000_evergreen_ranking). The column names (msats, downMsats,
-- boost, ranktop, ranklit, commentMsats, commentCost, commentBoost,
-- commentDownMsats) are kept verbatim; only their units become piconeros.
-- Fresh-baseline note: the backfill UPDATEs and the RankingType enum
-- recreation from the original migration are omitted (no existing rows on
-- a fresh DB). The four ranking indexes are generated by Prisma from the
-- schema's @@index declarations, so they are not re-added here.
-- =====================================================================

CREATE OR REPLACE FUNCTION item_ranking_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w DOUBLE PRECISION;
  old_sum DOUBLE PRECISION;
  old_at DOUBLE PRECISION;
  now_epoch DOUBLE PRECISION := EXTRACT(EPOCH FROM now())::DOUBLE PRECISION;
BEGIN
  -- 1. compute ranktop
  NEW.ranktop := (
    COALESCE(NEW.cost, 0)::double precision * 1000.0
    + COALESCE(NEW.msats, 0)::double precision
    + COALESCE(NEW.boost, 0)::double precision * 1000.0
    + COALESCE(NEW."commentMsats", 0)::double precision * 0.25
    + COALESCE(NEW."commentCost", 0)::double precision * 250.0
    + COALESCE(NEW."commentBoost", 0)::double precision * 250.0
    - COALESCE(NEW."downMsats", 0)::double precision
    - COALESCE(NEW."commentDownMsats", 0)::double precision * 0.1
  );

  -- 2. compute lit centered sum weight from field deltas
  IF TG_OP = 'INSERT' THEN
    w := (
      COALESCE(NEW.cost, 0)::double precision
      + COALESCE(NEW.msats, 0)::double precision / 1000.0
      + COALESCE(NEW.boost, 0)::double precision
      + COALESCE(NEW."commentMsats", 0)::double precision * 0.25 / 1000.0
      + COALESCE(NEW."commentCost", 0)::double precision * 0.25
      + COALESCE(NEW."commentBoost", 0)::double precision * 0.25
      - COALESCE(NEW."downMsats", 0)::double precision / 1000.0
      - COALESCE(NEW."commentDownMsats", 0)::double precision * 0.1 / 1000.0
    );
    old_sum := 0;
    old_at := 0;
  ELSE
    w := (
      (COALESCE(NEW.cost, 0) - COALESCE(OLD.cost, 0))::double precision
      + (COALESCE(NEW.msats, 0) - COALESCE(OLD.msats, 0))::double precision / 1000.0
      + (COALESCE(NEW.boost, 0) - COALESCE(OLD.boost, 0))::double precision
      + (COALESCE(NEW."commentMsats", 0) - COALESCE(OLD."commentMsats", 0))::double precision * 0.25 / 1000.0
      + (COALESCE(NEW."commentCost", 0) - COALESCE(OLD."commentCost", 0))::double precision * 0.25
      + (COALESCE(NEW."commentBoost", 0) - COALESCE(OLD."commentBoost", 0))::double precision * 0.25
      - (COALESCE(NEW."downMsats", 0) - COALESCE(OLD."downMsats", 0))::double precision / 1000.0
      - (COALESCE(NEW."commentDownMsats", 0) - COALESCE(OLD."commentDownMsats", 0))::double precision * 0.1 / 1000.0
    );
    old_sum := OLD."litCenteredSum";
    old_at := OLD."litCenteredAt";
  END IF;

  -- 3. update litCenteredSum via exponential decay centered at litCenteredAt
  --    EXP() arguments are <= 0 by construction (no overflow), but can underflow
  --    when the time gap exceeds ~168 days. GREATEST(..., -700) clamps the exponent
  --    to a safe range (IEEE 754 min ≈ -708); the decayed term is effectively 0.
  IF w <> 0 THEN
    IF now_epoch >= old_at THEN
      -- decay old sum to now, then add w
      NEW."litCenteredSum" := old_sum * EXP(GREATEST(LN(2) * (old_at - now_epoch) / 14400.0, -700.0)) + w;
    ELSE
      -- old_at is in the future: add w scaled by decay from old_at to now
      NEW."litCenteredSum" := old_sum + w * EXP(GREATEST(LN(2) * (now_epoch - old_at) / 14400.0, -700.0));
    END IF;
    NEW."litCenteredAt" := GREATEST(old_at, now_epoch);
  END IF;

  -- 4. compute ranklit sort key
  NEW.ranklit := CASE
    WHEN NEW."litCenteredSum" > 0
      THEN LN(NEW."litCenteredSum") + LN(2) / 14400.0 * NEW."litCenteredAt"
    WHEN NEW."litCenteredSum" < 0
      THEN -(LN(-NEW."litCenteredSum") + LN(2) / 14400.0 * NEW."litCenteredAt")
    ELSE 0
  END;

  RETURN NEW;
END;
$$;

CREATE TRIGGER item_ranking
  BEFORE INSERT OR UPDATE OF cost, msats, boost, "commentMsats", "commentCost", "commentBoost", "downMsats", "commentDownMsats"
  ON "Item"
  FOR EACH ROW EXECUTE FUNCTION item_ranking_trigger();
