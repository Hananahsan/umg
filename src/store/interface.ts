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
  delete(id: string): Promise<void>;
  archive(id: string): Promise<void>;

  search(query: SearchQuery): Promise<ScoredMemory[]>;
  list(filter: ListFilter): Promise<Memory[]>;
  count(filter: CountFilter): Promise<number>;

  findSimilar(content: string, opts?: SimilarOpts): Promise<ScoredMemory[]>;

  /** Run fn inside a SQLite transaction when supported. */
  transaction<T>(fn: () => T): T;

  logEvent(event: MemoryEvent): Promise<void>;
  listEvents(limit?: number): Promise<MemoryEvent[]>;
  purgeOldEvents(maxEvents: number): Promise<number>;
  purgeArchivedOlderThan(isoCutoff: string): Promise<number>;

  stats(defaultNamespace: string): Promise<StatsSnapshot>;

  /** Key/value meta (schema version, last_prune_at, etc.). */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  close(): void;
}
