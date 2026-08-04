import type {
  CountFilter,
  ListFilter,
  Memory,
  MemoryEvent,
  ScoredMemory,
  SearchQuery,
  SimilarOpts,
  StatsSnapshot,
} from "../types.js";

/**
 * Storage port. v1 implements SqliteMemoryStore.
 * Future backends (Mem0, Zep) implement this same interface —
 * no multi-backend router in v1.
 */
export interface MemoryStore {
  put(memory: Memory): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, patch: Partial<Memory>): Promise<Memory>;
  archive(id: string): Promise<void>;
  // No delete(). Archiving is the only removal the service layer may perform,
  // because it is the only one with a path back. A raw row delete leaves no
  // audit record and no way to recover the content, so it lives off the port
  // as SqliteMemoryStore.deleteUnaudited() and is reachable only by code that
  // has deliberately reached for the concrete adapter (seeding, FTS tests).

  search(query: SearchQuery): Promise<ScoredMemory[]>;
  list(filter: ListFilter): Promise<Memory[]>;
  count(filter: CountFilter): Promise<number>;

  findSimilar(content: string, opts?: SimilarOpts): Promise<ScoredMemory[]>;

  /** Run fn inside a SQLite transaction when supported. */
  transaction<T>(fn: () => T): T;

  logEvent(event: MemoryEvent): Promise<void>;
  listEvents(limit?: number): Promise<MemoryEvent[]>;
  purgeOldEvents(maxEvents: number): Promise<number>;

  /**
   * Hard-delete archived memories last touched before `isoCutoff`.
   *
   * Returns the ids removed, not a count. This is the only sanctioned path by
   * which a memory's content leaves the database for good, so the retention
   * invariant needs to tell "purged under policy" apart from "vanished" — and
   * it can only do that from ids. Returning the ids rather than a count makes
   * the auditable form the only form: a caller cannot obtain the number
   * without also holding the evidence, so there is no shape of this call that
   * silently drops the record. `.length` is the count.
   */
  purgeArchivedOlderThan(isoCutoff: string): Promise<string[]>;

  stats(defaultNamespace: string): Promise<StatsSnapshot>;

  /** Key/value meta (schema version, last_prune_at, etc.). */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /** Entity → count of active memories in namespace (for rarity scoring). */
  entityFrequency(namespace: string, limit?: number): Promise<Map<string, number>>;

  dbFileSizeBytes(): number;
  vacuum(): void;
  listArchived(limit?: number): Promise<Memory[]>;

  /** Whether BM25 search is live. False means the degraded LIKE fallback is in use. */
  isFtsAvailable(): boolean;

  close(): void;
}
