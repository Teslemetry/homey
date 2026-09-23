// Test-only ESM redirect target for "@teslemetry/api" (see loader.mjs).
// app.js's `new Teslemetry(...)` calls resolve here instead of constructing
// the real SDK - constructing it for real would issue live network calls
// from createProducts()/sse.connect(). Each test configures the next
// instance's behavior via configureTeslemetryStub() before triggering a
// build, so it controls createProducts() timing/outcome and can drive the
// returned sse EventEmitter directly.
//
// battery/device.ts also has a runtime import of getTariffPeriods from this
// package, so every "@teslemetry/api" import - not just app.js's - resolves
// here. Re-export the real getTariffPeriods (pure tariff-window math, no
// network I/O) via a relative file path so the tariff tests still exercise
// actual behavior instead of a hand-rolled fake; a bare "@teslemetry/api"
// re-import here would just recurse back into this same redirect.
//
// TeslemetryStream is re-exported the same way for the same reason: its
// _dispatch() routing of a wire event to the right per-product emitter is
// the thing energy-site-live-dispatch.test.ts has to exercise for real
// (see that file's header), and constructing one performs no I/O until
// connect() is called.
export {
  getTariffPeriods,
  TeslemetryStream,
} from "../../node_modules/@teslemetry/api/dist/index.mjs";

let nextFactory = null;

export function configureTeslemetryStub(factory) {
  nextFactory = factory;
}

export class Teslemetry {
  constructor(accessTokenFn, options) {
    if (!nextFactory) {
      throw new Error(
        "teslemetry-api-stub: call configureTeslemetryStub() before constructing Teslemetry",
      );
    }
    return nextFactory(accessTokenFn, options);
  }
}
