// Smoke-test ESM loader: redirects the "homey" runtime package, which only
// resolves to real classes inside the actual Homey runtime, to a local stub.
// oxlint-disable-next-line import/prefer-default-export -- Node loader hooks require a named export.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "homey") {
    return nextResolve(
      new URL("./homey-stub.js", import.meta.url).href,
      context,
    );
  }
  return nextResolve(specifier, context);
}
