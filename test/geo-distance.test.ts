import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import haversineDistanceMeters from "../.homeybuild/lib/geoDistance.js";

test("haversineDistanceMeters returns 0 for identical points", () => {
  assert.equal(haversineDistanceMeters(52.0, 5.0, 52.0, 5.0), 0);
});

test("haversineDistanceMeters matches R*radians(dLat) for two points on the same meridian", () => {
  const R = 6_371_000;
  const dLatDegrees = 1;
  const expected = R * (dLatDegrees * Math.PI) / 180;
  const actual = haversineDistanceMeters(52.0, 5.0, 52.0 + dLatDegrees, 5.0);
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `expected ~${expected}, got ${actual}`,
  );
});

test("haversineDistanceMeters is symmetric", () => {
  const a = haversineDistanceMeters(52.0, 5.0, 48.8566, 2.3522);
  const b = haversineDistanceMeters(48.8566, 2.3522, 52.0, 5.0);
  assert.equal(a, b);
});

test("haversineDistanceMeters approximates the known London-Paris great-circle distance", () => {
  // London: 51.5074, -0.1278; Paris: 48.8566, 2.3522. Real geodesic distance
  // is ~344km; a spherical approximation should land within a few km of it.
  const distance = haversineDistanceMeters(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(
    Math.abs(distance - 344_000) < 5_000,
    `expected ~344km, got ${distance / 1000}km`,
  );
});
