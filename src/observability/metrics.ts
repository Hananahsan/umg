import type { MemoryStore } from "../store/interface.js";
import type { Metrics7d } from "../types.js";

/**
 * Rolling window metrics derived from the events table (offline, no extra deps).
 */
export async function computeMetrics7d(
  store: MemoryStore,
  windowDays: number,
): Promise<Metrics7d> {
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Fetch a generous slice; filter by window in memory
  const events = await store.listEvents(5000);
  const inWindow = events.filter((e) => e.ts >= since);

  let created = 0;
  let archived = 0;
  let skills_promoted = 0;
  let recalls_total = 0;
  let recalls_high_value = 0;
  let decaySum = 0;
  let decayN = 0;

  for (const e of inWindow) {
    if (e.kind === "retain" && e.detail?.reason !== "conflict_deferred") {
      // count successful creates; merge events separate
      if (!e.detail?.reason || e.detail.reason !== "conflict_deferred") {
        created++;
      }
    }
    if (e.kind === "merge") {
      // merge is not a new create; ignore for created
    }
    if (
      e.kind === "archive" ||
      e.kind === "evict" ||
      (e.kind === "prune" && typeof e.detail?.archived === "number")
    ) {
      if (e.kind === "prune" && typeof e.detail.archived === "number") {
        archived += Number(e.detail.archived) || 0;
      } else {
        archived++;
      }
    }
    if (e.kind === "promote" && !e.detail?.dry_run && !e.detail?.rejected) {
      skills_promoted++;
    }
    if (e.kind === "recall") {
      recalls_total++;
      const top = Number(e.detail?.top_score ?? 0);
      const hv = e.detail?.high_value === true || top >= 0.4;
      if (hv) recalls_high_value++;
      if (typeof e.detail?.avg_decay === "number") {
        decaySum += Number(e.detail.avg_decay);
        decayN++;
      }
    }
  }

  // recount created more carefully: retain events without reject
  created = inWindow.filter(
    (e) =>
      e.kind === "retain" &&
      e.detail?.reason !== "conflict_deferred" &&
      e.detail?.action !== "rejected",
  ).length;
  // also count from detail.action if present
  const retainCreated = inWindow.filter(
    (e) => e.kind === "retain" && e.detail?.action === "created",
  ).length;
  if (retainCreated > 0) created = retainCreated;
  const retainMerged = inWindow.filter(
    (e) => e.kind === "retain" && e.detail?.action === "merged",
  ).length;
  // Merges aren't new rows; supersedes create new
  const retainSuper = inWindow.filter(
    (e) => e.kind === "retain" && e.detail?.action === "superseded",
  ).length;
  if (retainCreated + retainSuper > 0) {
    created = retainCreated + retainSuper;
  } else {
    void retainMerged;
  }

  const prune_effectiveness =
    created > 0 ? archived / created : archived > 0 ? 1 : 0;

  return {
    created,
    archived,
    skills_promoted,
    prune_effectiveness: Number(prune_effectiveness.toFixed(3)),
    avg_decay_on_recall: decayN ? Number((decaySum / decayN).toFixed(3)) : 0,
    recalls_total,
    recalls_high_value,
    high_value_recall_rate:
      recalls_total > 0
        ? Number((recalls_high_value / recalls_total).toFixed(3))
        : 0,
  };
}
