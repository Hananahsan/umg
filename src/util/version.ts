import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the version reported by the CLI and the MCP
 * handshake. Read from package.json at runtime rather than hardcoded, because
 * the two used to drift — the MCP server advertised 0.1.0 while the package
 * shipped 0.2.1.
 *
 * package.json sits one level above both `src/` and `dist/`, so the same
 * relative path resolves whether this runs from source via tsx or from the
 * built output.
 */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    if (pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0-unknown";
}

export const VERSION: string = readVersion();
