import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MemoryTier } from "./types.js";

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
  };
  consolidation: {
    merge_threshold: number;
    /** Full-prune merge/supersede passes (bounded). */
    merge_max_passes: number;
    light_prune_every_n_writes: number;
    eviction_floor: number;
    archive_retention_days: number;
    grace_period_days: number;
    auto_promote: boolean;
    promote_min_recalls: number;
    promote_min_sessions: number;
    archive_sources_on_promote: boolean;
    /**
     * When false (default): procedural never score-floor or global-cap evicted,
     * and tier-cap excess is skipped (skills protected).
     */
    evict_procedural: boolean;
    half_lives_days: Record<MemoryTier, number>;
    caps: Record<MemoryTier | "global", number>;
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
  };
}

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
  },
  consolidation: {
    merge_threshold: 0.82,
    merge_max_passes: 3,
    light_prune_every_n_writes: 25,
    eviction_floor: 0.12,
    archive_retention_days: 90,
    grace_period_days: 3,
    auto_promote: true,
    promote_min_recalls: 3,
    promote_min_sessions: 2,
    archive_sources_on_promote: true,
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

export function loadConfig(options?: {
  configPath?: string;
  dbPath?: string;
}): UmgConfig {
  const path = findConfigPath(options?.configPath);
  let fileCfg: Partial<UmgConfig> = {};
  if (path) {
    const raw = readFileSync(path, "utf8");
    fileCfg = (parseYaml(raw) as Partial<UmgConfig>) ?? {};
  }
  let cfg = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileCfg as Record<string, unknown>) as unknown as UmgConfig;
  cfg = applyEnv(cfg);
  if (options?.dbPath) cfg.db_path = options.dbPath;
  cfg.db_path = resolve(expandHome(cfg.db_path));
  return cfg;
}

/** Ensure parent directory for the DB exists. */
export function ensureDbDir(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function defaultConfig(): UmgConfig {
  return structuredClone(DEFAULTS);
}

export { DEFAULTS as DEFAULT_CONFIG };
