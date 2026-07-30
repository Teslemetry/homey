import test from "node:test";
import assert from "node:assert/strict";
import correctTpmsTimestampMs from "../.homeybuild/drivers/vehicle/tpms.js";

test("correctTpmsTimestampMs undoes the Pacific-Time mislabeling during PDT (summer)", () => {
  // 2024-07-15 12:00:00 PDT (UTC-7) = 2024-07-15 19:00:00 UTC.
  const rawSeconds = Date.UTC(2024, 6, 15, 19, 0, 0) / 1000;

  // The vehicle's true local wall-clock reading time was 12:00:00 on
  // 2024-07-15, reinterpreted as UTC digits.
  const expected = Date.UTC(2024, 6, 15, 12, 0, 0);

  assert.equal(correctTpmsTimestampMs(rawSeconds), expected);
});

test("correctTpmsTimestampMs undoes the Pacific-Time mislabeling during PST (winter)", () => {
  // 2024-01-15 12:00:00 PST (UTC-8) = 2024-01-15 20:00:00 UTC.
  const rawSeconds = Date.UTC(2024, 0, 15, 20, 0, 0) / 1000;

  const expected = Date.UTC(2024, 0, 15, 12, 0, 0);

  assert.equal(correctTpmsTimestampMs(rawSeconds), expected);
});
