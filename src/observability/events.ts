import type { MemoryStore } from "../store/interface.js";
import type { EventKind, MemoryEvent } from "../types.js";
import { newEventId } from "../store/memory-ids.js";
import { nowIso } from "../util/text.js";
import type { UmgConfig } from "../config.js";

export async function emitEvent(
  store: MemoryStore,
  cfg: UmgConfig,
  kind: EventKind,
  detail: Record<string, unknown>,
  memoryId?: string,
): Promise<void> {
  if (!cfg.observability.event_log) return;
  const event: MemoryEvent = {
    id: newEventId(),
    ts: nowIso(),
    kind,
    memory_id: memoryId ?? null,
    detail,
  };
  await store.logEvent(event);
  // Bound event log size opportunistically
  if (Math.random() < 0.05) {
    await store.purgeOldEvents(cfg.observability.max_events);
  }
}
