import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/**
 * Built UI assets, copied here from inspector-ui/dist by
 * scripts/copy-inspector-assets.mjs during `npm run build`.
 */
export function assetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "public");
}

export function assetsPresent(): boolean {
  return existsSync(join(assetRoot(), "index.html"));
}

/** Resolve a URL path inside the asset root, refusing traversal. */
function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Serve a built asset. Unknown paths fall back to index.html so the SPA can
 * own its own routing. Returns false when the asset root is missing entirely.
 */
export function serveAsset(urlPath: string, res: ServerResponse): boolean {
  const root = assetRoot();
  const index = join(root, "index.html");
  if (!existsSync(index)) return false;

  let file = urlPath === "/" ? index : safeJoin(root, urlPath);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    file = index;
  }

  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    // Local tool, always-fresh data; hashed asset names make this cheap anyway.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}
