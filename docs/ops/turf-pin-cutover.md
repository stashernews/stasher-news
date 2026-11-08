# Independent turf pins — production cutover

This is a deployment checklist, not authorization to run production commands.
Use the approved release and the VPS's **full Compose file/env-file chain** for
every service operation. Do not substitute `sndev start`, `sndev monero up`, or
a base-file-only `docker compose up` on production.

## Release behavior

- Turf pins move from `Item.pinId` onto `ItemSub.pinPosition`, independently for
  each turf. Reply and global (no-turf) legacy pins remain unchanged.
- **Paid update compatibility change:** an omitted `subNames` in `ITEM_UPDATE`
  now preserves all memberships and their pins, rather than defaulting to `[]`
  and removing them. An explicit array still reconciles memberships; an
  explicit `[]` removes all memberships and their turf pins. Reposts send the
  full list. This does not grant new permissions to public mutation callers.
- New feeds do not read legacy turf pins. If the app is exposed before the
  backfill succeeds, those posts lose their pinned placement (not their
  content) and appear organically instead. **Do not reopen traffic early.**

Known deferred risk: a turf rename overlapping a pin/lifecycle write can
deadlock and abort one transaction. Concurrent rename handling is explicitly
out of scope for this release; avoid renaming turfs during pin operations.

## Preparation

1. Record the current release, Compose chain, pending migrations, and existing
   pin destinations/order. Rehearse the migration and backfill against a
   protected database copy; keep database dumps and mapping files private.
2. Prepare a maintenance window. Stop **all app and worker replicas**, drain
   requests/jobs, and stop any other scripts or automation that write posts,
   memberships, pins, turf names, or ownership. Prevent automatic restarts.
   Keep writers stopped until verification and cutover finish; the backfill
   does not provide online migration safety or normal app-writer lock ordering.
3. Stage the new release and its locked dependencies without starting it.
   Use Node 22.23.4 and the release's generated Prisma client. Load
   `DATABASE_URL` and other required configuration via the approved secret
   loader; never print secrets. Commands below run from that release's root
   in a migration-capable environment with database access, `pg_dump`, and
   Node available. A one-off container must use the same release/configuration
   and must not start dependent app/worker services.

## Migrate, check, resolve, apply (writers still stopped)

Use the snapshot-before-migration wrapper:

```sh
bash scripts/deploy-migrate.sh
npx --no-install prisma migrate status
```

Verify the snapshot is present, readable, and restorable using the established
backup procedure, not just the wrapper's exit code. Retain it through cutover.
The wrapper generates Prisma Client before applying pending migrations. Verify
`20261108000000_independent_turf_pins` is applied and inspect any other pending
migrations before authorizing the run.

The turf-pin migration adds a nullable column, a CHECK constraint, a
**non-concurrent** index, and replaces the membership trigger. The constraint
validation/index scan can hold locks and block writers. Do not assume it is
sub-second: measure on a production-sized copy and budget the window. For a
larger dataset, separately approve a staged/concurrent-index migration; do not
edit the checksummed migration after it has been applied.

Run the read-only preflight:

```sh
npx --no-install tsx --tsconfig jsconfig.json scripts/backfill-turf-pins.js --check
```

**Check mode can exit zero with `BLOCKED` lines.** Inspect the entire report;
every blocker must be resolved before applying:

| Blocker | Required decision |
| --- | --- |
| Multi-turf ambiguity | Choose one existing membership as the destination in a private mapping file. The script never duplicates a legacy pin across all turfs. |
| Shared legacy Pin | Obtain an approved preservation treatment; a mapping does not bypass this blocker. Do not flatten recurring/shared history. |
| Cron/timezone or queued repin job | Obtain an approved scheduling transition before proceeding; a mapping does not bypass this blocker. |
| Scalar/membership disagreement | Investigate and repair the underlying drift with a separately approved correction. |
| Existing membership pin conflict | Confirm the intended preserved state; do not blindly overwrite either model. |
| More than six pins in a destination | Decide which pins to keep; the script will not truncate them. |

Mapping format (example only):

```json
{ "12345": "canonicalTurfName" }
```

Create the mapping outside the repository with restrictive permissions; the
destination must already be a membership of the post. When using a container,
mount the private file read-only and use its container-visible absolute path.
Pass the **same** mapping to check and apply:

```sh
npx --no-install tsx --tsconfig jsconfig.json scripts/backfill-turf-pins.js --check --mapping /absolute/private/turf-pin-mapping.json
npx --no-install tsx --tsconfig jsconfig.json scripts/backfill-turf-pins.js --apply --mapping /absolute/private/turf-pin-mapping.json
```

Omit `--mapping` if no mapping is needed. Apply rechecks preflight inside one
transaction; any blocker or write failure rolls it all back. Its final cap
check guards against a last-slot race, **not** arbitrary concurrent writers.
Keep maintenance in place if apply fails; investigate rather than bypassing
guards or starting the app with unresolved legacy pins.

## Verify and reopen

1. Confirm apply reports the expected promotion/deleted-link counts. Deleted
   turf posts only have their obsolete `Item.pinId` link cleared. Legacy Pin
   rows are retained; reply/global links and existing new-style pins are not
   rewritten.
2. Rerun `--check` with the same mapping. Expect zero turf-post candidates and
   zero blockers; scanned rows can remain for reply/global history. A repeat
   `--apply` with the same mapping must report zero promotions/cleared links.
3. Build the production app using the approved procedure. Restart **both app
   and worker** on this release with regenerated Prisma clients, keeping
   public traffic gated until health and feed checks pass.
4. Verify pinned order against the recorded destinations, independent pin
   display for a repost in two turfs, unmodified reply pins, normal organic
   feeds, pagination, and absence of Prisma/GraphQL errors. Only perform
   pin/unpin writes on an approved test post/turf. Reopen traffic and monitor.

## Rollback and the accompanying OpenSearch upgrade

- Before backfill, the additive schema retains legacy links. After successful
  backfill, promoted posts have **no legacy `Item.pinId`**: old application
  code alone cannot restore their turf pins. Prefer a forward fix or an
  approved data reversal. Snapshot restoration requires maintenance and an
  explicit accounting/data-loss assessment; do not restore over new user or
  payment writes. Prisma migrations are forward-only; follow the existing
  restore procedure with `ON_ERROR_STOP`, then verify schema and release match.
- The same release bumps OpenSearch/Dashboards from 3.3.0 to 3.9.0. Take and
  verify an **OpenSearch index snapshot** before that upgrade (the PostgreSQL
  dump does not cover search data). Keep matching server/Dashboards versions,
  verify cluster health/index counts and a representative search afterward,
  and retain a tested rebuild/restore plan. Do not assume that downgrading the
  image against a volume already written by 3.9.0 is safe. Run this upgrade as
  a separate, observable step using the full production Compose chain.
