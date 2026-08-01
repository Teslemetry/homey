#!/usr/bin/env node
// tesla-fleet-api is a `github:` dependency whose own dist/ is produced by its
// "prepare" script (tsc). The Homey app-publish action runs `npm ci --ignore-scripts`,
// which skips that script for every installed package, so dist/ never gets built there.
// Compile it here explicitly, using the same compiler options as its own tsconfig.json,
// as an ordinary step of our own build (unaffected by --ignore-scripts).
//
// Homey CLI's own preprocess() (App.js: build/validate/run/publish all funnel through
// it) copies node_modules into .homeybuild/node_modules BEFORE it runs the "build" npm
// script that invokes this file - so by the time this file builds dist/ into the *root*
// node_modules/tesla-fleet-api, .homeybuild's own copy of that package was already taken
// without one. That's the actual published/run bundle; mirroring the freshly-built dist/
// into it too (if that copy already exists) is what makes it ship complete.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../node_modules/tesla-fleet-api", import.meta.url));
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");
const homeyBuildPkgDist = fileURLToPath(
  new URL("../.homeybuild/node_modules/tesla-fleet-api/dist", import.meta.url),
);

function mirrorToHomeyBuild() {
  if (existsSync(path.dirname(homeyBuildPkgDist))) {
    cpSync(distDir, homeyBuildPkgDist, { recursive: true });
  }
}

if (existsSync(distDir)) {
  mirrorToHomeyBuild();
  process.exit(0);
}

function collectTsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const tscBin = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

execFileSync(
  process.execPath,
  [
    tscBin,
    "--target", "es2020",
    "--module", "nodenext",
    "--moduleResolution", "nodenext",
    "--esModuleInterop",
    "--declaration",
    "--sourceMap",
    "--strict", "false",
    "--types", "node",
    "--outDir", distDir,
    "--rootDir", srcDir,
    "--ignoreConfig",
    ...collectTsFiles(srcDir),
  ],
  { stdio: "inherit" },
);

mirrorToHomeyBuild();
