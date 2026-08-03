import type { UmgConfig } from "./config.js";
import { loadConfig, ensureDbDir } from "./config.js";
import { configureLogging, log } from "./util/log.js";
import { SqliteMemoryStore } from "./store/sqlite/store.js";
import { ReadOnlyStore } from "./store/readonly.js";
import type { MemoryStore } from "./store/interface.js";
import { MemoryService } from "./services/memory.js";
import { ConsolidationService } from "./services/consolidation.js";
import { PromotionService } from "./services/promotion.js";
import { ReflectService } from "./services/reflect.js";
import { runStartupMaintenance } from "./startup.js";

export interface UmgApp {
  cfg: UmgConfig;
  store: MemoryStore;
  memory: MemoryService;
  consolidation: ConsolidationService;
  promotion: PromotionService;
  reflect: ReflectService;
  close: () => void;
}

export function createApp(options?: {
  configPath?: string;
  dbPath?: string;
  cfg?: UmgConfig;
  /** Open the store read-only (used by `umg0 inspect`). */
  readonly?: boolean;
  /** Use this store instead of opening one (used by the inspector demo). */
  store?: MemoryStore;
}): UmgApp {
  const cfg = options?.cfg ?? loadConfig({
    configPath: options?.configPath,
    dbPath: options?.dbPath,
  });
  configureLogging(cfg);

  let store: MemoryStore;
  if (options?.store) {
    store = options.store;
  } else if (options?.readonly) {
    store = new ReadOnlyStore(
      new SqliteMemoryStore(cfg.db_path, cfg, { readonly: true }),
    );
  } else {
    ensureDbDir(cfg.db_path);
    store = new SqliteMemoryStore(cfg.db_path, cfg);
  }

  const memory = new MemoryService(store, cfg);
  const consolidation = new ConsolidationService(store, cfg);
  const promotion = new PromotionService(store, cfg, memory);
  const reflect = new ReflectService(store, cfg, memory);

  memory.setConsolidation(consolidation);
  consolidation.setPromotion(promotion);

  log.info("UMG ready", {
    db: cfg.db_path,
    namespace: cfg.default_namespace,
  });

  return {
    cfg,
    store,
    memory,
    consolidation,
    promotion,
    reflect,
    close: () => store.close(),
  };
}

/** Create app and run startup maintenance (light prune if stale). */
export async function bootstrapApp(options?: {
  configPath?: string;
  dbPath?: string;
  cfg?: UmgConfig;
  skipStartupPrune?: boolean;
}): Promise<UmgApp> {
  const app = createApp(options);
  await runStartupMaintenance(app, { skip: options?.skipStartupPrune });
  return app;
}
