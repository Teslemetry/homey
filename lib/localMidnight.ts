interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * UTC instant (ms) of local midnight on (year, month, day) in `timeZone`.
 * `Intl` only maps a UTC instant to wall-clock parts, not the reverse, so
 * this guesses the instant by treating the wall time as if it were UTC,
 * then corrects by the zone's actual offset at that guess - iterating
 * because the offset itself can change (a DST transition) between the
 * guess and the true answer.
 */
function zonedMidnightToUtcMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const targetAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const guessedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const diff = guessedAsUtc - targetAsUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/**
 * Milliseconds from `now` until the next local-midnight boundary in
 * `timeZone`. Resolves the next calendar day's midnight through the zone's
 * actual UTC offset for that day rather than subtracting wall-clock elapsed
 * time from a fixed 24h, so a DST transition day (23h/25h) is correct
 * instead of off by the transition's size.
 */
export default function msUntilNextLocalMidnight(
  now: Date,
  timeZone: string,
): number {
  const { year, month, day } = getZonedParts(now, timeZone);
  // Date.UTC normalizes day overflow (e.g. day 32 in March -> April 1), so
  // this also handles month/year rollover for free.
  return zonedMidnightToUtcMs(year, month, day + 1, timeZone) - now.getTime();
}
