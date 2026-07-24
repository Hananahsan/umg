/** Hierarchical memory tiers. */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";

/** Lifecycle status. */
export type MemoryStatus = "active" | "archived" | "evicted";

/** Canonical memory record. */
export interface Memory {
  id: string;
  tier: MemoryTier;
  status: MemoryStatus;
  content: string;
  summary?: string | null;
  namespace: string;
  tags: string[];
  entities: string[];
  source?: string | null;
  session_id?: string | null;
  importance: number;
  confidence: number;
  access_count: number;
  last_accessed_at: string;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  decay_score: number;
  /** Reserved for future hybrid search; unused in v1 retrieval. */
  embedding?: number[] | null;
  metadata: Record<string, unknown>;
  parent_ids: string[];
  supersedes_id?: string | null;
}

export interface ScoredMemory extends Memory {
  score: number;
  score_breakdown?: Record<string, number>;
}

export interface SearchQuery {
  text?: string;
  namespace?: string;
  tiers?: MemoryTier[];
  tags?: string[];
  status?: MemoryStatus;
  limit?: number;
  min_score?: number;
  include_working?: boolean;
}

export interface ListFilter {
  namespace?: string;
  tiers?: MemoryTier[];
  tags?: string[];
  status?: MemoryStatus;
  session_id?: string;
  limit?: number;
  offset?: number;
  order_by?: "created_at" | "updated_at" | "importance" | "decay_score" | "last_accessed_at";
  order_dir?: "asc" | "desc";
}

export interface CountFilter {
  namespace?: string;
  tier?: MemoryTier;
  status?: MemoryStatus;
}

export interface SimilarOpts {
  namespace?: string;
  tiers?: MemoryTier[];
  limit?: number;
  exclude_id?: string;
}

export type EventKind =
  | "retain"
  | "recall"
  | "merge"
  | "decay"
  | "evict"
  | "archive"
  | "promote"
  | "reflect"
  | "reject"
  | "prune";

export interface MemoryEvent {
  id: string;
  ts: string;
  kind: EventKind;
  memory_id?: string | null;
  detail: Record<string, unknown>;
}

export type RetainAction = "created" | "merged" | "rejected" | "superseded";

export interface RetainResult {
  action: RetainAction;
  id?: string;
  tier?: MemoryTier;
  merged_into?: string;
  /** Prior memory archived as superseded by this write. */
  superseded_id?: string;
  reason?: string;
  memory?: Memory;
}

export interface RecallResult {
  memories: ScoredMemory[];
  query: string;
  count: number;
}

export interface PruneResult {
  dry_run: boolean;
  decayed: number;
  merged: number;
  archived: number;
  purged: number;
  promoted: number;
  details: Array<Record<string, unknown>>;
}

export interface ReflectCandidate {
  content: string;
  tier: MemoryTier;
  importance: number;
  tags: string[];
  entities: string[];
  reason: string;
}

export interface ReflectResult {
  candidates: ReflectCandidate[];
  retained: RetainResult[];
  mode: string;
}

export interface PromoteResult {
  id: string;
  memory: Memory;
  source_ids: string[];
  archived_sources: string[];
}

export interface StatsSnapshot {
  active_by_tier: Record<MemoryTier, number>;
  archived: number;
  total_active: number;
  avg_decay: number;
  avg_importance: number;
  recent_events: Array<{ kind: string; ts: string; detail: Record<string, unknown> }>;
  db_path: string;
  namespace_default: string;
}

export const MEMORY_TIERS: MemoryTier[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
];
