/**
 * Milliseconds from `now` until the next local-midnight boundary in
 * `timeZone`. Recomputed fresh from `now` on every call rather than adding
 * a fixed 24h, so a DST transition day (23h/25h) can't compound drift into
 * later days - only that one boundary is off by up to an hour.
 */
export default function msUntilNextLocalMidnight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const msSinceLocalMidnight =
    ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 +
    now.getMilliseconds();
  // now exactly at midnight -> a full day until the *next* one, not 0
  // (avoids a same-instant re-fire loop when this is called right after a
  // midnight reset fires).
  return 24 * 60 * 60 * 1000 - msSinceLocalMidnight;
}
