/** Hierarchical memory tiers. */

export interface RankingWeights {
  fts: number;
  importance: number;
  decay: number;
  tier: number;
  recency: number;
  entity: number;
}
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
  /** Optional hybrid search vector; unused unless embeddings.enabled. */
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
  order_by?:
    | "created_at"
    | "updated_at"
    | "importance"
    | "decay_score"
    | "last_accessed_at";
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
  proposed_skills?: Array<Record<string, unknown>>;
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
  dry_run?: boolean;
  rejected?: boolean;
  rejected_reason?: string;
}

export interface Metrics7d {
  created: number;
  archived: number;
  skills_promoted: number;
  prune_effectiveness: number;
  avg_decay_on_recall: number;
  recalls_total: number;
  recalls_high_value: number;
  high_value_recall_rate: number;
}

export interface StatsSnapshot {
  active_by_tier: Record<MemoryTier, number>;
  archived: number;
  total_active: number;
  avg_decay: number;
  avg_importance: number;
  recent_events: Array<{
    kind: string;
    ts: string;
    detail: Record<string, unknown>;
  }>;
  db_path: string;
  namespace_default: string;
  ranking_weights?: RankingWeights;
  db_size_bytes?: number;
  db_size_warn?: boolean;
  /** False means BM25 search is off and the degraded LIKE fallback is in use. */
  fts_available: boolean;
  metrics_7d?: Metrics7d;
}

export const MEMORY_TIERS: MemoryTier[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
];
