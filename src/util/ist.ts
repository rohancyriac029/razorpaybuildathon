// IST = UTC+5:30, no DST, ever. Good enough to compute directly rather than
// pull in a timezone library for one offset that never changes.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

export function istHourOfDay(d: Date): number {
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const istMinutes = (utcMinutes + IST_OFFSET_MINUTES) % (24 * 60);
  return Math.floor(istMinutes / 60);
}

/** True for the P4 blackout window: 22:00–08:00 IST (wraps past midnight). */
export function isIstBlackoutHour(d: Date): boolean {
  const hour = istHourOfDay(d);
  return hour >= 22 || hour < 8;
}

/** Start of the current IST calendar day, as a UTC Date — for P10's daily contact cap. */
export function istMidnightUtc(d: Date): Date {
  const istMs = d.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  const istDate = new Date(istMs);
  istDate.setUTCHours(0, 0, 0, 0);
  return new Date(istDate.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
}
