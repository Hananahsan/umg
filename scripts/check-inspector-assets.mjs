#!/usr/bin/env node
/**
 * Fail if the committed inspector UI build is stale.
 *
 * inspector-ui/dist is committed so the published package and a fresh clone
 * both work without installing the UI toolchain. That only holds if the
 * committed output actually matches inspector-ui/src, so CI rebuilds it and
 * diffs the result.
 *
 * Dependency versions in inspector-ui/package.json are pinned exactly for
 * this reason — a floating range would fail this check on unrelated drift.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "inspector-ui", "dist");

function manifest(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.set(relative(dir, full), hash.slice(0, 16));
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return out;
  }
  return out;
}

const before = manifest(distDir);
if (before.size === 0) {
  console.error("[inspector] inspector-ui/dist is missing or empty — commit a build");
  process.exit(1);
}

execFileSync("npm", ["--prefix", "inspector-ui", "run", "build"], {
  cwd: root,
  stdio: "inherit",
});

const after = manifest(distDir);
const names = [...new Set([...before.keys(), ...after.keys()])].sort();
const drift = names.filter((n) => before.get(n) !== after.get(n));

if (drift.length > 0) {
  console.error("\n[inspector] committed UI assets are stale:");
  for (const name of drift) {
    console.error(
      `  ${name}: committed=${before.get(name) ?? "(absent)"} rebuilt=${after.get(name) ?? "(absent)"}`,
    );
  }
  console.error("\nRun `npm run build:ui` and commit inspector-ui/dist.");
  process.exit(1);
}

console.log(`[inspector] committed UI assets are current (${after.size} files)`);
