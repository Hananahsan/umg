import { spawn } from "node:child_process";
import { log } from "../util/log.js";

/** Best-effort browser open. Never throws — the URL is always printed too. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      log.debug("could not open browser", { error: String(err) });
    });
    child.unref();
  } catch (err) {
    log.debug("could not open browser", { error: String(err) });
  }
}
