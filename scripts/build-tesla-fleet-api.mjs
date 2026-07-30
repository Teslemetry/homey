#!/usr/bin/env node
// tesla-fleet-api is a `github:` dependency whose own dist/ is produced by its
// "prepare" script (tsc). The Homey app-publish action runs `npm ci --ignore-scripts`,
// which skips that script for every installed package, so dist/ never gets built there.
// Compile it here explicitly, using the same compiler options as its own tsconfig.json,
// as an ordinary step of our own build (unaffected by --ignore-scripts).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../node_modules/tesla-fleet-api", import.meta.url));
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");

if (existsSync(distDir)) {
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
