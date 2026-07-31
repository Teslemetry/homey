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
