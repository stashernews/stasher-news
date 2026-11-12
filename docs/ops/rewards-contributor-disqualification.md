# Contributor rewards — disqualifying a post

Scope: removing a specific post from the weekly contributor pool (plagiarism,
AI-generated text, rule breaking) without deleting the post, its tips, or any
historical payout.

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
- notifies its author ("this post is not eligible for contributor rewards"),
  showing the reason and never who decided it;
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
    "contributorDisqualifiedReason" = 'PLAGIARISM',
    "contributorDisqualifiedNote" = 'copied from <source>, checked <date>'
WHERE id = 12345 AND "parentId" IS NULL;
```

## Clear a flag

```sql
UPDATE "Item"
SET "contributorDisqualifiedAt" = NULL,
    "contributorDisqualifiedReason" = NULL,
    "contributorDisqualifiedNote" = NULL
WHERE id = 12345;
```

Clearing removes the author's notification.

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
