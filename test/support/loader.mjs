// Test-only ESM loader: redirects the "homey" runtime package (which only
// resolves to real classes inside the actual Homey runtime) to a local
// stub so compiled driver files can be imported and exercised directly.
// Also redirects "@teslemetry/api" to a controllable stub - app.js is the
// only compiled file with a runtime (not type-only) import from it, and
// constructing the real Teslemetry class would make live network calls.
// oxlint-disable-next-line import/prefer-default-export -- Node loader hooks require a named export.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "homey") {
    return nextResolve(
      new URL("./homey-stub.js", import.meta.url).href,
      context,
    );
  }
  if (specifier === "@teslemetry/api") {
    return nextResolve(
      new URL("./teslemetry-api-stub.js", import.meta.url).href,
      context,
    );
  }
  return nextResolve(specifier, context);
}
