-- Remove pg-boss schedules whose workers no longer exist (Lightning/views-era
-- jobs removed by the Monero strip) plus the legacy daily earn jobs, which are
-- superseded by the weekly rewardsDistributor. Without this, schedules fire
-- jobs that no worker consumes and the queues accumulate stuck `created` jobs.

DELETE FROM pgboss.schedule
WHERE name IN (
  'views-hours', 'views-days', 'views-months', 'rankViews', 'auction',
  'territoryRevenue', 'checkPendingPayInBolt11s', 'checkPendingPayOutBolt11s',
  'checkPendingPayInInvoiceCreations', 'halloween', 'autoDropBolt11s',
  'earn', 'earnRefill'
);

-- Drop the backlog those schedules fired with no consumer.
DELETE FROM pgboss.job
WHERE name IN (
  'views-hours', 'views-days', 'views-months', 'rankViews', 'auction',
  'territoryRevenue', 'checkPendingPayInBolt11s', 'checkPendingPayOutBolt11s',
  'checkPendingPayInInvoiceCreations', 'halloween', 'autoDropBolt11s',
  'earn', 'earnRefill'
);
