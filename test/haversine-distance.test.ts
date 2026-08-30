import test from "node:test";
import assert from "node:assert/strict";
import haversineDistanceKm from "../.homeybuild/lib/haversineDistance.js";

test("the distance between identical coordinates is zero", () => {
  assert.equal(
    haversineDistanceKm(
      { latitude: 51.5, longitude: -0.12 },
      { latitude: 51.5, longitude: -0.12 },
    ),
    0,
  );
});

test("one degree of latitude is approximately 111.19 km", () => {
  const distance = haversineDistanceKm(
    { latitude: 0, longitude: 0 },
    { latitude: 1, longitude: 0 },
  );

  assert.ok(Math.abs(distance - 111.19) < 0.01, `expected ~111.19, got ${distance}`);
});

test("matches the known great-circle distance between New York and Los Angeles", () => {
  const distance = haversineDistanceKm(
    { latitude: 40.7128, longitude: -74.006 },
    { latitude: 34.0522, longitude: -118.2437 },
  );

  assert.ok(Math.abs(distance - 3935.75) < 1, `expected ~3935.75, got ${distance}`);
});
