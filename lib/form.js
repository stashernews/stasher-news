import { hasDeleteMention, hasReminderMention } from './item'

export const toastUpsertSuccessMessages = (toaster, upsertResponseData, dataKey, itemText) => {
  const SCHEDULERS = {
    delete: {
      hasMention: hasDeleteMention,
      scheduledAtKey: 'deleteScheduledAt',
      mention: '@delete'
    },
    remindme: {
      hasMention: hasReminderMention,
      scheduledAtKey: 'reminderScheduledAt',
      mention: '@remindme'
    }
  }

  for (const key in SCHEDULERS) {
    const { hasMention, scheduledAtKey, mention } = SCHEDULERS[key]
    if (hasMention(itemText)) {
      const scheduledAt = upsertResponseData[dataKey]?.payerPrivates?.result?.[scheduledAtKey]
      const options = { persistOnNavigate: dataKey !== 'upsertComment' }
      if (scheduledAt) {
        toaster.success(`${mention} bot will trigger at ${new Date(scheduledAt).toLocaleString()}`, options)
      } else {
        toaster.warning(`It looks like you tried to use the ${mention} bot but it didn't work. Make sure you use the correct format: "${mention} in n units" e.g. "${mention} in 2 hours"`, options)
      }
    }
  }
}
