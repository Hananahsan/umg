import type { UmgConfig } from "./config.js";
import { loadConfig, ensureDbDir } from "./config.js";
import { configureLogging, log } from "./util/log.js";
import { SqliteMemoryStore } from "./store/sqlite/store.js";
import type { MemoryStore } from "./store/interface.js";
import { MemoryService } from "./services/memory.js";
import { ConsolidationService } from "./services/consolidation.js";
import { PromotionService } from "./services/promotion.js";
import { ReflectService } from "./services/reflect.js";

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
}): UmgApp {
  const cfg = options?.cfg ?? loadConfig({
    configPath: options?.configPath,
    dbPath: options?.dbPath,
  });
  configureLogging(cfg);
  ensureDbDir(cfg.db_path);

  const store = new SqliteMemoryStore(cfg.db_path);
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
