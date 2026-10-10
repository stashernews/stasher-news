# Newsletter runbook (Resend Broadcasts + Contacts)

The newsletter is a **biweekly community roundup** sent as a Resend **Broadcast**
to a **Segment** of **Contacts**. It runs on Resend's *marketing* plane — a
separate quota from the transactional 100/day shared by login codes and the
weekly digest, so a blast can never starve them. Spec:
`docs/superpowers/specs/2026-10-06-newsletter-design.md`.

Local state: `users.newsletterOptIn` (default **true** — soft opt-in for
verified accounts), `users.newsletterSuppressed` (set by bounce/complaint
webhooks; the reconcile never re-subscribes these), `users.resendContactId`,
and one `NewsletterCampaign` row per issue (`periodKey` = ISO week, the
idempotency key).

## Provision (once)

1. Resend dashboard → create a **Segment** named e.g. `stasher-news` and
   (optionally) a **Topic** named `newsletter`. Record the segment UUID.
2. Create an **API key** with **full access** (resource management), not
   "sending access": Contacts and Broadcasts are API resources, and a
   sending-only key produces a configured-looking but nonfunctional
   newsletter. This key is distinct from the SMTP key embedded in
   `LOGIN_EMAIL_SERVER`.
3. Create a **Webhook** → `https://stasher.news/api/resend/webhook` subscribed
   to: `contact.updated`, `email.bounced`, `email.complained`,
   `suppression.added`. Copy the **signing secret** (`whsec_...`).
4. Brand the hosted unsubscribe page (Resend → Settings) — broadcasts use
   Resend's native per-recipient `{{{RESEND_UNSUBSCRIBE_URL}}}`.
5. Secrets into `.env.local` / SOPS: `RESEND_API_KEY`,
   `RESEND_WEBHOOK_SECRET`, `NEWSLETTER_SEGMENT_ID` (and optionally
   `NEWSLETTER_EDITORIAL_FILE`). Non-secrets already live in
   `.env.production` (`NEWSLETTER_FROM=newsletter@stasher.news`,
   `NEWSLETTER_REPLY_TO=hello@stasher.news`, `NEWSLETTER_ENABLED=true`,
   `NEWSLETTER_AUTO_SEND=false`).
6. Remove any stale `LIST_MONK_*` vars from the VPS SOPS env (dead feature).
7. Recreate the worker so it picks the env up: the prodmode compose chain
   restart, then verify:
   - `/api/health` → `newsletter.configured: true`
   - `/metrics` → `newsletter_configured 1`
   - logs: no `newsletter sync skipped` warn in the last daily run

## Verify config is visible (never silent)

With the newsletter enabled but a required var missing, the daily
`newsletterSync` job logs `newsletterSync: skipped — unset env {missing}`,
fires one deduped `warn` alert (`newsletter-env`), pins
`newsletter_configured 0`, and `/api/health` reports `configured: false/null`.
Fix the env and recreate the worker; the next tick self-heals.

## Import the existing population (one-time, repeatable)

Dry-run first — counts only, never addresses:

```bash
# dev
docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/newsletter-sync.js
# VPS (loader-wrapped: bare docker exec does NOT inherit SOPS-exported secrets)
NODE_ENV=production docker compose --env-file .env.development --env-file .env.local \
  -f docker-compose.yml -f docker-compose.volumes.yml -f docker-compose.prod.yml -f docker-compose.prodmode.yml \
  run --rm --entrypoint /etc/stashernews/scripts/load-secrets-local.sh app \
  npx tsx --tsconfig jsconfig.json scripts/newsletter-sync.js
```

Then add `--apply` (same invocation) to write. Idempotent — the import IS the
daily reconcile; re-running is always safe. Expected fields: `eligible`,
`enrolled`, `failed`, `hintSkipped` (address-drift guard), `suppressed`,
`toUnsubscribe`, `unsubscribed`.

## Preview the next issue (no send)

Renders the newsletter with the SAME content gatherer and template the worker
uses, writing HTML + text to local files. It creates no Broadcast, makes no
Resend call, and reads no secrets (so it cannot leak addresses):

```bash
docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/newsletter-preview.js
# options: --days 14 --site https://stasher.news --out /tmp/newsletter-preview.html
```

The editorial slot (`NEWSLETTER_EDITORIAL_FILE`, default
`/etc/stashernews/newsletter-editorial.md`) is included when present.

## Send (biweekly)

Cron-owned: `newsletterCampaign` ticks weekly (Mon 16:00 UTC) but only builds
an issue when the last `sentAt` is ≥14 days old. Per issue:

1. Worker gathers content (top posts, most discussed, territory movement,
   optional editorial from `NEWSLETTER_EDITORIAL_FILE`), renders, creates a
   Broadcast **draft**, and sends a test to `NEWSLETTER_TEST_TO`.
2. Review: your inbox test shot + Resend dashboard preview/analytics.
   (API-created broadcasts are sent via API only — the dashboard's
   slide-to-send works only for dashboard-created ones. You can still compose
   ad-hoc one-off announcements to the same segment entirely in the dashboard.)
3. Release: `scripts/newsletter-send.js` (latest DRAFT; `--id <broadcastId>`
   to target one) via the loader-wrapped VPS form above, or set
   `NEWSLETTER_AUTO_SEND=true` to skip the gate.

## Pause

- `NEWSLETTER_ENABLED=false` → recreate worker. Jobs log + exit; cron rows stay.
- `NEWSLETTER_DRY_RUN=true` → issues are recorded but no Resend call is made.
- Resend dashboard can also cancel a queued broadcast (stops remaining sends).

## Unsubscribe / suppression

- Recipients use Resend's native link (one-click, RFC 8058). `contact.updated`
  (`unsubscribed: true`) → our webhook sets `newsletterOptIn=false`. The
  Settings toggle is the in-app control (best-effort immediate Resend push;
  daily reconcile backstops).
- Hard bounces/complaints: Resend suppresses automatically; `email.bounced` /
  `email.complained` / `suppression.added` webhooks set
  `newsletterSuppressed=true` locally. Complaints additionally fire a critical
  alert — **watch these**: Resend's AUP threshold is complaint rate < 0.08%,
  bounce < 4%.
- Inspect locally: `SELECT name, "newsletterOptIn", "newsletterSuppressed"
  FROM users WHERE "resendContactId" IS NOT NULL;` (counts, not addresses).
  The authoritative suppression list is the Resend dashboard.

## Quota & cost

- Marketing plane: free tier = unlimited broadcasts to ≤1,000 contacts;
  beyond that Marketing Pro $40/mo @5,000 contacts. **Separate from** the
  transactional quota (3,000/mo, 100/day) that login codes + digest share.
- Never treat Resend's ~30-day send log as the list — the list is our DB
  (source of truth) mirrored into Resend Contacts.
- Kit/MailerLite were evaluated and rejected — see the spec's channel decision
  (Kit additionally restricts crypto platforms to account-by-account scrutiny).

## Failure modes

- Sync/campaign jobs are cron-owned; a failed run self-heals at the next tick.
  `newsletter-enroll` alerts (`newsletter-enroll`) on permanent Resend
  rejection; the daily reconcile retries the user anyway.
- A duplicated period is impossible without manual DB edits: `periodKey` is
  unique and the watermark blocks <14-day gaps.
- Webhook signature failures log `resendWebhook: rejected {reason}` and 400 —
  check `RESEND_WEBHOOK_SECRET` matches the dashboard signing secret.
