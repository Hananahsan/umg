import type { UmgApp } from "./app.js";
import { log } from "./util/log.js";
import { nowIso } from "./util/text.js";

const LAST_PRUNE_KEY = "last_prune_at";
/** Plan default: light prune on startup if last prune older than 24h. */
const STARTUP_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Run once after app construction (MCP boot / CLI).
 * - Light prune if never pruned or last prune > 24h
 */
export async function runStartupMaintenance(
  app: UmgApp,
  opts?: { force?: boolean; skip?: boolean },
): Promise<{ pruned: boolean; reason: string }> {
  if (opts?.skip) {
    return { pruned: false, reason: "skipped" };
  }

  const last = app.store.getMeta(LAST_PRUNE_KEY);
  const now = Date.now();
  let should = opts?.force === true;

  if (!should) {
    if (!last) {
      should = true;
    } else {
      const ts = Date.parse(last);
      if (Number.isNaN(ts) || now - ts >= STARTUP_PRUNE_AFTER_MS) {
        should = true;
      }
    }
  }

  if (!should) {
    log.debug("startup prune skipped", { last_prune_at: last });
    return { pruned: false, reason: "recent_prune" };
  }

  try {
    const result = await app.consolidation.prune({ light: true });
    log.info("startup light prune complete", {
      decayed: result.decayed,
      archived: result.archived,
      last_prune_at: last ?? null,
      now: nowIso(),
    });
    return { pruned: true, reason: last ? "stale" : "first_boot" };
  } catch (err) {
    log.warn("startup prune failed (continuing)", { error: String(err) });
    return { pruned: false, reason: "error" };
  }
}
