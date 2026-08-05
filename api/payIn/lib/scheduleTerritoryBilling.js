// Schedule the territoryBilling worker to fire when the sub's current paid
// coverage ends. Inserted inside the territory payIn onBegin transaction so the
// schedule commits with the billing change. pg-boss v9 mints job ids
// client-side — supply gen_random_uuid() like the other raw INSERTs.
export async function scheduleTerritoryBilling (tx, subName, billPaidUntil) {
  if (!billPaidUntil) return
  await tx.$executeRaw`
    INSERT INTO pgboss.job (id, name, data, startafter, priority)
    VALUES (gen_random_uuid(), 'territoryBilling', jsonb_build_object('subName', ${subName}), ${billPaidUntil}::timestamptz, 1000)`
}
