#!/usr/bin/env node
/**
 * Copy the committed inspector UI build into dist/inspector/public.
 *
 * Runs as part of `npm run build` (after tsc). It deliberately does NOT build
 * the UI: inspector-ui has its own dependency tree, and a fresh
 * `git clone && npm install && npm run build` must work without installing it.
 * Rebuild the assets with `npm run build:ui` when inspector-ui/src changes.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "inspector-ui", "dist");
const dest = join(root, "dist", "inspector", "public");

if (!existsSync(join(src, "index.html"))) {
  console.error(
    `[inspector] no built UI at ${src}\n` +
      `[inspector] run: npm run build:ui`,
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[inspector] assets → dist/inspector/public`);
