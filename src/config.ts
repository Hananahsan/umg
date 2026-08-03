import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MemoryTier, RankingWeights } from "./types.js";
import { log } from "./util/log.js";

export type { RankingWeights };

export interface DecayConfig {
  alpha: number;
  beta: number;
  access_saturation: number;
  procedural_access_saturation: number;
  session_boost: number;
  session_boost_half_life_hours: number;
}

export interface UmgConfig {
  db_path: string;
  default_namespace: string;
  log_level: "debug" | "info" | "warn" | "error";
  retain: {
    min_importance: Record<MemoryTier, number>;
    max_content_chars: number;
    auto_tier: boolean;
  };
  recall: {
    default_limit: number;
    max_limit: number;
    min_score: number;
    ranking_weights: RankingWeights;
  };
  consolidation: {
    merge_threshold: number;
    /** Mirrors supersede_min_confidence: below this, keep both and defer. */
    merge_min_confidence: number;
    merge_max_passes: number;
    light_prune_every_n_writes: number;
    eviction_floor: number;
    archive_retention_days: number;
    grace_period_days: number;
    auto_promote: boolean;
    promote_min_recalls: number;
    promote_min_sessions: number;
    archive_sources_on_promote: boolean;
    promote_min_avg_importance: number;
    promote_min_skill_chars: number;
    promote_dry_run_proposed: boolean;
    supersede_min_confidence: number;
    evict_procedural: boolean;
    half_lives_days: Record<MemoryTier, number>;
    caps: Record<MemoryTier | "global", number>;
    decay: DecayConfig;
  };
  sqlite: {
    busy_timeout_ms: number;
    size_warn_bytes: number;
  };
  namespace: {
    hard_isolation: boolean;
  };
  embeddings: {
    enabled: boolean;
    provider: string;
    model: string;
    api_key_env: string;
    base_url: string | null;
    hybrid_fts_weight: number;
    hybrid_cosine_weight: number;
  };
  reflect: {
    max_extract: number;
    auto_retain: boolean;
    llm: {
      enabled: boolean;
      provider: string;
      model: string;
      base_url: string | null;
      api_key_env: string;
    };
  };
  observability: {
    event_log: boolean;
    max_events: number;
    metrics_window_days: number;
  };
}

/**
 * Provisional merge threshold. Merge currently lacks the safety machinery the
 * write path has everywhere else: supersede is confidence-gated and falls back
 * to additive on ambiguity, but merge is a bare threshold — above it, one
 * memory is discarded and its content is gone.
 *
 * Until merge is confidence-gated and defers instead of discarding, this is
 * held high enough that effectively only exact and near-identical duplicates
 * collapse. It is a safety measure, not a calibrated value; do not tune it
 * without a labeled corpus.
 */
export const MERGE_SAFETY_THRESHOLD = 0.95;

export const MERGE_SAFETY_NOTE =
  "merge_threshold is a provisional safety value (0.95), not a tuned one: " +
  "merge discards a memory on a bare threshold, and true duplicates overlap " +
  "with distinct facts on the current similarity scale.";

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  fts: 0.32,
  importance: 0.18,
  decay: 0.18,
  tier: 0.08,
  recency: 0.08,
  entity: 0.16,
};

const DEFAULTS: UmgConfig = {
  db_path: "~/.umg/memory.db",
  default_namespace: "global",
  log_level: "info",
  retain: {
    min_importance: {
      working: 0.15,
      episodic: 0.35,
      semantic: 0.5,
      procedural: 0.6,
    },
    max_content_chars: 4000,
    auto_tier: true,
  },
  recall: {
    default_limit: 8,
    max_limit: 25,
    min_score: 0.08,
    ranking_weights: { ...DEFAULT_RANKING_WEIGHTS },
  },
  consolidation: {
    /**
     * TEMPORARY SAFETY VALUE — not a tuned threshold. See MERGE_SAFETY_NOTE.
     *
     * At the previous default of 0.82 merge was destroying data: the pair
     * "The staging API base URL is https://staging.example.com/v1" and
     * "The production API base URL is https://api.example.com/v1" scores
     * 0.8455 on this scale and was collapsed into one row, silently deleting
     * the production URL. Meanwhile genuine duplicates scoring 0.62–0.81 were
     * left alone, so 0.82 produced bloat and data loss at the same time.
     *
     * Measured against a labeled corpus, true duplicates and distinct facts
     * overlap on this scale, so no threshold separates them — see
     * tests/merge-safety.test.ts. 0.95 is chosen to sit above everything the
     * corpus produces, which means only exact-hash duplicates and
     * near-identical text still merge. That trades bloat for safety, which is
     * the correct direction until merge is made fail-safe.
     */
    merge_threshold: MERGE_SAFETY_THRESHOLD,
    merge_min_confidence: 0.75,
    merge_max_passes: 3,
    light_prune_every_n_writes: 25,
    eviction_floor: 0.12,
    archive_retention_days: 90,
    grace_period_days: 3,
    auto_promote: true,
    promote_min_recalls: 3,
    promote_min_sessions: 2,
    archive_sources_on_promote: true,
    promote_min_avg_importance: 0.55,
    promote_min_skill_chars: 80,
    promote_dry_run_proposed: false,
    supersede_min_confidence: 0.75,
    evict_procedural: false,
    half_lives_days: {
      working: 0.5,
      episodic: 14,
      semantic: 120,
      procedural: 730,
    },
    caps: {
      working: 50,
      episodic: 500,
      semantic: 1000,
      procedural: 200,
      global: 2000,
    },
    decay: {
      alpha: 0.65,
      beta: 0.35,
      access_saturation: 5,
      procedural_access_saturation: 12,
      session_boost: 0.15,
      session_boost_half_life_hours: 4,
    },
  },
  sqlite: {
    busy_timeout_ms: 5000,
    size_warn_bytes: 52_428_800,
  },
  namespace: {
    hard_isolation: false,
  },
  embeddings: {
    enabled: false,
    provider: "openai_compatible",
    model: "text-embedding-3-small",
    api_key_env: "UMG_EMBEDDING_API_KEY",
    base_url: null,
    hybrid_fts_weight: 0.55,
    hybrid_cosine_weight: 0.25,
  },
  reflect: {
    max_extract: 5,
    auto_retain: true,
    llm: {
      enabled: false,
      provider: "openai_compatible",
      model: "gpt-4.1-mini",
      base_url: null,
      api_key_env: "UMG_LLM_API_KEY",
    },
  },
  observability: {
    event_log: true,
    max_events: 10_000,
    metrics_window_days: 7,
  },
};

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1).replace(/^\//, "") || "");
  }
  return p;
}

function deepMerge<T extends Record<string, unknown>>(base: T, over: Partial<T>): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    const key = k as keyof T;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(
        base[key] as Record<string, unknown>,
        v as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      out[key] = v as T[keyof T];
    }
  }
  return out;
}

function validateRankingWeights(w: RankingWeights): void {
  const sum =
    w.fts + w.importance + w.decay + w.tier + w.recency + w.entity;
  if (Math.abs(sum - 1.0) > 0.02) {
    log.warn("ranking_weights sum is not ~1.0 (continuing anyway)", {
      sum,
      weights: w,
    });
  }
}

function applyEnv(cfg: UmgConfig): UmgConfig {
  const next = { ...cfg };
  if (process.env.UMG_DB_PATH) next.db_path = process.env.UMG_DB_PATH;
  if (process.env.UMG_NAMESPACE) next.default_namespace = process.env.UMG_NAMESPACE;
  if (process.env.UMG_LOG_LEVEL) {
    const lvl = process.env.UMG_LOG_LEVEL.toLowerCase();
    if (lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error") {
      next.log_level = lvl;
    }
  }
  if (process.env.UMG_LLM_ENABLED === "1" || process.env.UMG_LLM_ENABLED === "true") {
    next.reflect = {
      ...next.reflect,
      llm: { ...next.reflect.llm, enabled: true },
    };
  }
  if (process.env.UMG_LLM_MODEL) {
    next.reflect = {
      ...next.reflect,
      llm: { ...next.reflect.llm, model: process.env.UMG_LLM_MODEL },
    };
  }
  if (process.env.UMG_LLM_BASE_URL) {
    next.reflect = {
      ...next.reflect,
      llm: { ...next.reflect.llm, base_url: process.env.UMG_LLM_BASE_URL },
    };
  }
  if (
    process.env.UMG_EMBEDDINGS_ENABLED === "1" ||
    process.env.UMG_EMBEDDINGS_ENABLED === "true"
  ) {
    next.embeddings = { ...next.embeddings, enabled: true };
  }
  if (process.env.UMG_HARD_ISOLATION === "1" || process.env.UMG_HARD_ISOLATION === "true") {
    next.namespace = { ...next.namespace, hard_isolation: true };
  }
  return next;
}

function findConfigPath(explicit?: string): string | null {
  if (explicit) {
    const p = resolve(expandHome(explicit));
    return existsSync(p) ? p : null;
  }
  const candidates = [
    resolve("umg.config.yaml"),
    resolve("umg.config.yml"),
    join(homedir(), ".umg", "config.yaml"),
    join(homedir(), ".umg", "config.yml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Accept consolidation.ranking_weights as alias for recall.ranking_weights. */
function applyRankingAlias(fileCfg: Record<string, unknown>, cfg: UmgConfig): UmgConfig {
  const cons = fileCfg.consolidation as Record<string, unknown> | undefined;
  const recall = fileCfg.recall as Record<string, unknown> | undefined;
  if (cons?.ranking_weights && !recall?.ranking_weights) {
    cfg.recall = {
      ...cfg.recall,
      ranking_weights: {
        ...cfg.recall.ranking_weights,
        ...(cons.ranking_weights as RankingWeights),
      },
    };
  }
  return cfg;
}

export function loadConfig(options?: {
  configPath?: string;
  dbPath?: string;
}): UmgConfig {
  const path = findConfigPath(options?.configPath);
  let fileCfg: Record<string, unknown> = {};
  if (path) {
    const raw = readFileSync(path, "utf8");
    fileCfg = (parseYaml(raw) as Record<string, unknown>) ?? {};
  }
  let cfg = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileCfg,
  ) as unknown as UmgConfig;
  cfg = applyRankingAlias(fileCfg, cfg);
  cfg = applyEnv(cfg);
  if (options?.dbPath) cfg.db_path = options.dbPath;
  cfg.db_path = resolve(expandHome(cfg.db_path));
  validateRankingWeights(cfg.recall.ranking_weights);
  return cfg;
}

export function ensureDbDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function defaultConfig(): UmgConfig {
  return structuredClone(DEFAULTS);
}

export { DEFAULTS as DEFAULT_CONFIG };
