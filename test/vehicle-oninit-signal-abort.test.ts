import test from "node:test";

// A dedicated fix for VehicleDevice.onInit is in flight (see the
// vehicle-oninit-signal-throw-abort finding): unlike PowerwallDevice (#28),
// onInit's long signal-registration block has no guard against an early
// cached-signal replay throwing synchronously, which today aborts every
// registration after it - state/connectivity SSE listeners and every
// command capability listener included. Left as a todo rather than
// asserting either the current buggy behavior or the not-yet-shipped fix;
// the fix PR should replace this with a real regression test asserting the
// corrected (resilient) behavior.
test.todo(
  "VehicleDevice.onInit registers state/connectivity listeners and every command capability listener even when an early cached signal replay throws",
);
