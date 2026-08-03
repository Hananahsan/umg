import type { MemoryStore } from "./interface.js";
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

/** Thrown when a mutating store method is reached through a read-only store. */
export class ReadOnlyViolationError extends Error {
  constructor(public readonly method: string) {
    super(
      `MemoryStore.${method}() was called on a read-only store. ` +
        `The inspector must never mutate memories.`,
    );
    this.name = "ReadOnlyViolationError";
  }
}

/**
 * Read-only facade over a MemoryStore, used by `umg0 inspect`.
 *
 * Two classes of write exist in the service layer, and they need different
 * treatment:
 *
 *   - Memory mutations (put/update/delete/archive/purge/vacuum) must never
 *     happen. Reaching one during a dry run is a bug, so these throw loudly
 *     and the test suite asserts they never fire.
 *
 *   - Incidental telemetry (logEvent/purgeOldEvents/setMeta) is emitted
 *     unconditionally by ConsolidationService.prune() and
 *     PromotionService.promoteToSkill() even when dry_run is true. Throwing
 *     there would break an otherwise-valid dry run, so those are absorbed.
 *
 * The underlying SQLite connection is also opened read-only, so this class is
 * the outer of two independent guarantees rather than the only one.
 */
export class ReadOnlyStore implements MemoryStore {
  /** Counts absorbed telemetry writes; surfaced by the inspector for debugging. */
  private suppressed = 0;

  constructor(private readonly inner: MemoryStore) {}

  get suppressedWrites(): number {
    return this.suppressed;
  }

  // ---- reads: straight delegation -----------------------------------------

  get(id: string): Promise<Memory | null> {
    return this.inner.get(id);
  }

  search(query: SearchQuery): Promise<ScoredMemory[]> {
    return this.inner.search(query);
  }

  list(filter: ListFilter): Promise<Memory[]> {
    return this.inner.list(filter);
  }

  count(filter: CountFilter): Promise<number> {
    return this.inner.count(filter);
  }

  findSimilar(content: string, opts?: SimilarOpts): Promise<ScoredMemory[]> {
    return this.inner.findSimilar(content, opts);
  }

  listEvents(limit?: number): Promise<MemoryEvent[]> {
    return this.inner.listEvents(limit);
  }

  stats(defaultNamespace: string): Promise<StatsSnapshot> {
    return this.inner.stats(defaultNamespace);
  }

  getMeta(key: string): string | null {
    return this.inner.getMeta(key);
  }

  entityFrequency(
    namespace: string,
    limit?: number,
  ): Promise<Map<string, number>> {
    return this.inner.entityFrequency(namespace, limit);
  }

  dbFileSizeBytes(): number {
    return this.inner.dbFileSizeBytes();
  }

  listArchived(limit?: number): Promise<Memory[]> {
    return this.inner.listArchived(limit);
  }

  /**
   * Read-only transactions are safe: better-sqlite3 permits BEGIN/COMMIT on a
   * readonly connection, and any write inside would have thrown already.
   */
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }

  close(): void {
    this.inner.close();
  }

  // ---- absorbed telemetry -------------------------------------------------

  async logEvent(_event: MemoryEvent): Promise<void> {
    this.suppressed++;
  }

  async purgeOldEvents(_maxEvents: number): Promise<number> {
    this.suppressed++;
    return 0;
  }

  setMeta(_key: string, _value: string): void {
    this.suppressed++;
  }

  // ---- refused mutations --------------------------------------------------
  //
  // These reject rather than throwing synchronously. The port declares them as
  // Promise-returning, so a caller using `.catch()` must be able to handle the
  // refusal instead of taking a synchronous throw it never guarded against.
  // vacuum() is declared void and so throws directly.

  async put(_memory: Memory): Promise<Memory> {
    throw new ReadOnlyViolationError("put");
  }

  async update(_id: string, _patch: Partial<Memory>): Promise<Memory> {
    throw new ReadOnlyViolationError("update");
  }

  async delete(_id: string): Promise<void> {
    throw new ReadOnlyViolationError("delete");
  }

  async archive(_id: string): Promise<void> {
    throw new ReadOnlyViolationError("archive");
  }

  async purgeArchivedOlderThan(_isoCutoff: string): Promise<number> {
    throw new ReadOnlyViolationError("purgeArchivedOlderThan");
  }

  vacuum(): void {
    throw new ReadOnlyViolationError("vacuum");
  }
}
