// Monday 00:00 UTC of the week containing `date` (the rewards week boundary).
// One definition for the distributor, the alerts and the public pages.
// The following Monday 00:00 UTC: the upcoming run's week start.
export function nextUtcWeekStart (date = new Date()) {
  return new Date(utcWeekStart(date).getTime() + 7 * 24 * 60 * 60 * 1000)
}

export function utcWeekStart (date = new Date()) {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d
}
