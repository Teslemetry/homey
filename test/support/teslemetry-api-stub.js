// Test-only ESM redirect target for "@teslemetry/api" (see loader.mjs).
// app.js's `new Teslemetry(...)` calls resolve here instead of constructing
// the real SDK - constructing it for real would issue live network calls
// from createProducts()/sse.connect(). Each test configures the next
// instance's behavior via configureTeslemetryStub() before triggering a
// build, so it controls createProducts() timing/outcome and can drive the
// returned sse EventEmitter directly.
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
