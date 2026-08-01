#!/usr/bin/env node
/* eslint-disable no-console -- CLI output is the test report. */
// Verifies every compiled entry point (app.js, api.js, each driver's
// driver.js/device.js) actually loads out of the packaged .homeybuild/
// bundle - the thing Homey uploads and runs on-device, not this repo's own
// node_modules. A dependency missing from that bundle (e.g. tesla-fleet-api's
// dist/, see AGENTS.md's "tesla-fleet-api is pinned to a commit SHA" section)
// throws ERR_MODULE_NOT_FOUND on the device with no live device ever created,
// but `npm test` alone can't catch it: node_modules/ import resolution walks
// up past .homeybuild/node_modules to this repo's own node_modules, which
// always has every dependency built. Copying .homeybuild/ to an isolated
// directory with no such ancestor forces the same resolution the device
// actually gets.
//
// A plain `npm ci` (no --ignore-scripts, e.g. this repo's own CI/local dev)
// runs tesla-fleet-api's own "prepare" script and builds its dist/ before
// this script's `homey app build` call ever copies node_modules into
// .homeybuild/ - which would hide the exact ordering bug this test exists
// to catch. Deleting the built dist/ first forces the same worst case the
// actual publish pipeline's `npm ci --ignore-scripts` hits, regardless of
// how this script's own node_modules happened to get installed.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const homeyBuildPath = path.join(repoRoot, ".homeybuild");
const loaderPath = path.join(repoRoot, "test", "support", "loader.mjs");
const teslaFleetApiDist = path.join(repoRoot, "node_modules", "tesla-fleet-api", "dist");

if (existsSync(teslaFleetApiDist)) {
  rmSync(teslaFleetApiDist, { recursive: true, force: true });
}

execFileSync("npx", ["homey", "app", "build"], { cwd: repoRoot, stdio: "inherit" });

const isolatedDir = mkdtempSync(path.join(os.tmpdir(), "homeybuild-smoke-"));
try {
  cpSync(homeyBuildPath, isolatedDir, { recursive: true });

  const driversDir = path.join(isolatedDir, "drivers");
  const entryPoints = ["app.js", "api.js"];
  for (const driver of readdirSync(driversDir, { withFileTypes: true })) {
    if (!driver.isDirectory()) continue;
    for (const file of ["driver.js", "device.js"]) {
      entryPoints.push(path.join("drivers", driver.name, file));
    }
  }

  const failures = [];
  for (const entryPoint of entryPoints) {
    const fullPath = path.join(isolatedDir, entryPoint);
    try {
      execFileSync(
        process.execPath,
        [
          `--experimental-loader=${loaderPath}`,
          "--input-type=module",
          "-e",
          `import(${JSON.stringify(fullPath)})`,
        ],
        { cwd: isolatedDir, stdio: "pipe" },
      );
      console.log(`OK   ${entryPoint}`);
    } catch (error) {
      failures.push({ entryPoint, message: error.stderr?.toString() ?? error.message });
      console.error(`FAIL ${entryPoint}`);
    }
  }

  if (failures.length > 0) {
    console.error("\nPackaged build smoke test failed - a compiled entry point cannot load from the actual published bundle:");
    for (const { entryPoint, message } of failures) {
      console.error(`\n=== ${entryPoint} ===`);
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`\nPackaged build smoke test passed: ${entryPoints.length} entry points load cleanly from an isolated .homeybuild copy.`);
} finally {
  rmSync(isolatedDir, { recursive: true, force: true });
}
