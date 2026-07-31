import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import msUntilNextLocalMidnight from "../.homeybuild/lib/localMidnight.js";

test("msUntilNextLocalMidnight returns the remaining ms to midnight in the given timezone", () => {
  // 23:59:00 America/New_York (EDT, UTC-4 in July) - one minute to local midnight.
  const now = new Date("2026-07-30T23:59:00-04:00");
  assert.equal(msUntilNextLocalMidnight(now, "America/New_York"), 60_000);
});

test("msUntilNextLocalMidnight accounts for a timezone offset from UTC", () => {
  // 03:30 UTC = 13:30 Australia/Sydney (UTC+10 in the southern winter) -
  // 10.5 hours until local midnight.
  const now = new Date("2026-07-31T03:30:00Z");
  assert.equal(
    msUntilNextLocalMidnight(now, "Australia/Sydney"),
    10.5 * 60 * 60 * 1000,
  );
});

test("msUntilNextLocalMidnight returns a full day when now is exactly local midnight", () => {
  const now = new Date("2026-07-30T00:00:00-04:00");
  assert.equal(
    msUntilNextLocalMidnight(now, "America/New_York"),
    24 * 60 * 60 * 1000,
  );
});

test("msUntilNextLocalMidnight matches plain UTC math when the timezone is UTC", () => {
  const now = new Date("2026-07-30T18:15:30.500Z");
  const expected =
    24 * 60 * 60 * 1000 -
    (18 * 60 * 60 * 1000 + 15 * 60 * 1000 + 30 * 1000 + 500);
  assert.equal(msUntilNextLocalMidnight(now, "UTC"), expected);
});

test("msUntilNextLocalMidnight returns 22.5h on a spring-forward (23h) day in America/New_York", () => {
  // 2026-03-08: US DST starts at 02:00 EST -> 03:00 EDT. At 00:30 EST, 23.5h
  // of wall clock remain until next midnight, minus the 1h skipped forward.
  const now = new Date("2026-03-08T00:30:00-05:00");
  assert.equal(
    msUntilNextLocalMidnight(now, "America/New_York"),
    22.5 * 60 * 60 * 1000,
  );
});

test("msUntilNextLocalMidnight returns 24.5h on a fall-back (25h) day in America/New_York", () => {
  // 2026-11-01: US DST ends at 02:00 EDT -> 01:00 EST. At 00:30 EDT, 23.5h
  // of wall clock remain until next midnight, plus the 1h repeated.
  const now = new Date("2026-11-01T00:30:00-04:00");
  assert.equal(
    msUntilNextLocalMidnight(now, "America/New_York"),
    24.5 * 60 * 60 * 1000,
  );
});

test("msUntilNextLocalMidnight returns 23.5h from 00:30 on a non-transition day in America/New_York", () => {
  const now = new Date("2026-03-01T00:30:00-05:00");
  assert.equal(
    msUntilNextLocalMidnight(now, "America/New_York"),
    23.5 * 60 * 60 * 1000,
  );
});

test("msUntilNextLocalMidnight handles a non-hour UTC offset (Asia/Kolkata, UTC+5:30)", () => {
  // 18:00 UTC = 23:30 Asia/Kolkata - 30 minutes until local midnight.
  const now = new Date("2026-07-30T18:00:00Z");
  assert.equal(
    msUntilNextLocalMidnight(now, "Asia/Kolkata"),
    30 * 60 * 1000,
  );
});
