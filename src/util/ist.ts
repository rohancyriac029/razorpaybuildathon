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

/**
 * The same instant, written as an IST wall-clock time with an explicit +05:30
 * offset — `2026-08-30T08:00:00+05:30` rather than `2026-08-30T02:30:00.000Z`.
 *
 * Both name the same moment, but the propose tools ask the model for "ISO 8601
 * with offset", and handing it a `Z` string to copy is a trap: in the first
 * anchored pilot the model copied the digits out of the UTC string and re-tagged
 * them `+05:30`, shifting every proposal 5.5h earlier and landing 98 of 113
 * attempts inside the P4 blackout it was explicitly told to avoid. Anything
 * shown to the model as a time it might copy must already be in the format it
 * is being asked to produce.
 */
export function toIstOffsetString(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}` +
    `T${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}+05:30`
  );
}

/**
 * Snap a proposed send time out of the 22:00-08:00 IST blackout to the next
 * 08:00 IST. A deterministic strategy that only ever adds a fixed offset to
 * "now" (rules.ts's INSTRUMENT/TRANSIENT/FUNDS branches) has no other way to
 * avoid P4 — without this, whether a proposal survives policy depends on
 * what time of day the failure happened to occur, not on the strategy's own
 * judgment. OracleStrategy already does this inline (policySafeTime); this
 * is that same logic, shared.
 */
export function snapOutOfBlackout(target: Date): Date {
  return isIstBlackoutHour(target) ? nextIstClockTime(target, 8, 0) : target;
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
