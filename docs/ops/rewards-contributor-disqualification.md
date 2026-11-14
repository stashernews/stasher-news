# Contributor rewards — disqualifying a post

Scope: removing a specific post from the weekly contributor pool (plagiarism,
AI-generated text, rule breaking) without deleting the post, its tips, or any
historical payout.

## Private admin panel

Open Rewards & budget, then Post eligibility. Load the post by local URL or ID,
choose a reason and optional private note, then review the action. A separate
operator explanation is required for the audit. Every change is audited and
announced to operators, including changes made without notifying the author.

**Notify author** is unchecked by default. Checking it requests an in-app
notice with the categorical reason, never the private note or operator identity.
On an already notified post, leaving it unchecked preserves the existing notice
and its time. Editing the reason changes the text of that existing notice;
checking the box again moves the notice to the new decision time. Restoring
eligibility clears the flag and removes the notice, without sending a new one.

The panel rejects stale edits. If a response is lost, reload and inspect the
audit before retrying. An operator alert delivery failure does not undo a
committed eligibility change. Private notes are retained in the private audit,
not sent to the external operator alert channel.

Provisional public candidates can take five minutes to refresh. Final selection
reads the flag at distribution time. Changes cannot reverse winners already
selected by an in-progress or committed distribution, and restoring a flag
does not guarantee a future reward.

## Recorded scoring snapshots

The Contributor run snapshots card shows recorded counts, configuration,
funding and scored rows. SHADOW awards are hypothetical; ACTIVE awards are
allocations, not proof of on-chain delivery. Opening a snapshot does not rerun
scoring. Its recorded metrics remain unchanged when a post is disqualified.

Titles and author names are current metadata, not historical copies. The usual
snapshot retains up to 200 activity-bearing rows and all selected winners;
it is not a complete list of checked posts. Exclusion reasons are aggregate
counts, not per-post explanations. Missing values mean not recorded, not zero.
New snapshots record the IDs of the trusted tippers counted for each post.
The expanded scoring explanation lists their current account names and profile
links, with an ID fallback for accounts that are no longer available. Trust
qualification is fixed at scoring time; changing trust or renaming an account
does not change the saved account IDs. This list is private to operators.
Older snapshots do not contain these IDs and show that identities were not
recorded, rather than reconstructing them from current trust. Individual tip
amounts, tipper trust values and a separate downvote breakdown are not saved.

The flag lives on the post: `Item.contributorDisqualifiedAt`,
`contributorDisqualifiedReason` and `contributorDisqualifiedNote`. It is read
inside the weekly distribution transaction, so an edit takes effect on the next
Monday run. No worker restart is needed.

## Timing rule

Set the flag **before the Monday 00:00 UTC run** that would pay the post. Posts
are scored the week after their own 7-day tip window closes, so a post written
in week W is paid on the Monday that follows W+1. Review the week's candidates
during the days before that run (the `/rewards` page lists them by rank).

A flag set after the run changes nothing for that week. Edits are forward-only:
there is no clawback, and past distributions, payouts and `Earn` rows are never
rewritten.

## Effect of a flag

A disqualified post:

- is removed before ranking, so the next-ranked post moves up and takes the slot;
- is counted as `disqualified` in the run's ineligible counts;
- optionally notifies its author ("this post is not eligible for contributor rewards"),
  showing the reason and never who decided it; new flags are silent by default;
- keeps its tips, comments and normal visibility. This is not a ban.

The same author's other posts are unaffected. To block an author entirely, add
the account to the curator exclusion list instead (see
`rewards-curator-exclusions.md`), which also removes them from contributor
rewards.

## Reasons

`PLAGIARISM`, `AI_GENERATED`, `RULES`, `OTHER`. The note is private operator
text and is never shown to users.

## Disqualify a post

Replace `12345` with the post's `Item.id`.

```sql
UPDATE "Item"
SET "contributorDisqualifiedAt" = now(),
    "contributorModerationRevision" = "contributorModerationRevision" + 1,
     "contributorDisqualifiedReason" = 'PLAGIARISM',
     "contributorDisqualifiedNotifyAt" = NULL,
    "contributorDisqualifiedNote" = 'copied from <source>, checked <date>'
WHERE id = 12345 AND "parentId" IS NULL;
```

## Clear a flag

```sql
UPDATE "Item"
SET "contributorDisqualifiedAt" = NULL,
    "contributorModerationRevision" = "contributorModerationRevision" + 1,
     "contributorDisqualifiedReason" = NULL,
     "contributorDisqualifiedNotifyAt" = NULL,
    "contributorDisqualifiedNote" = NULL
WHERE id = 12345;
```

Clearing removes the author's notification.

To request an in-app author notice, explicitly set
`contributorDisqualifiedNotifyAt` to the decision time while the flag is set.
This does not send email or push messages. Existing flags are migrated with
their original notification time, preserving existing notices without moving
them to the top of the notification list.

## List current flags

```sql
SELECT id, "userId", "contributorDisqualifiedAt", "contributorDisqualifiedReason",
       "contributorDisqualifiedNote"
FROM "Item"
WHERE "contributorDisqualifiedAt" IS NOT NULL
ORDER BY "contributorDisqualifiedAt" DESC;
```

## After the run

The distribution's `contributorParams` records the week's ineligible counts,
including `disqualified`. Candidates and shares are listed there too; scores
are never shown to users.
