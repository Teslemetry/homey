const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const pacificTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * TpmsLastSeenPressureTime* reports a Unix timestamp that is wrong when read
 * directly - formatting it in Pacific Time instead yields the vehicle's true
 * local wall-clock reading time, a documented upstream Tesla API defect.
 * Reinterpreting those wall-clock digits as UTC recovers a value comparable
 * to Date.now() for freshness/staleness purposes.
 */
export default function correctTpmsTimestampMs(rawSeconds: number): number {
  const parts = pacificTimeFormatter.formatToParts(new Date(rawSeconds * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
}
