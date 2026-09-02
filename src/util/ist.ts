// IST = UTC+5:30, no DST, ever. Good enough to compute directly rather than
// pull in a timezone library for one offset that never changes.
export const IST_OFFSET_MINUTES = 5 * 60 + 30;

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

/** Calendar day-of-month (1-31) in IST — for the FUNDS/salary-cycle rule (spec §1.2, §5.3). */
export function istDayOfMonth(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MINUTES * 60 * 1000).getUTCDate();
}

/**
 * The next UTC instant at which the IST wall clock reads hour:minute,
 * strictly after `from` — today if that time hasn't passed yet in IST,
 * otherwise tomorrow. Used for the Rules strategy's "next 10:00-20:00 IST
 * slot" (spec §5.3, AUTH_ABANDONED).
 */
export function nextIstClockTime(from: Date, hour: number, minute = 0): Date {
  const istMs = from.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  const istShifted = new Date(istMs);
  const candidateIstLabeled = new Date(
    Date.UTC(
      istShifted.getUTCFullYear(),
      istShifted.getUTCMonth(),
      istShifted.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );
  let candidateUtc = new Date(candidateIstLabeled.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
  if (candidateUtc.getTime() <= from.getTime()) {
    candidateUtc = new Date(candidateUtc.getTime() + 24 * 3_600_000);
  }
  return candidateUtc;
}
