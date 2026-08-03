import type Database from "better-sqlite3";
import { SCHEMA_SQL, FTS_SQL, FTS_DROP_SQL, SCHEMA_VERSION } from "./schema.js";
import { log } from "../../util/log.js";

/**
 * Recreate the FTS table and triggers from scratch, then repopulate from `memories`.
 * Used both for first-time setup and to repair the broken v1 FTS definition.
 */
function rebuildFts(db: Database.Database): void {
  db.exec(FTS_DROP_SQL);
  db.exec(FTS_SQL);
  // 'rebuild' reads straight from the content table, so it only works once the
  // FTS column names line up with `memories`.
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

function setVersion(db: Database.Database, version: number): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;

  const current = row ? Number(row.value) : 0;
  if (current >= SCHEMA_VERSION) return;

  // Every version up to 2 differs only in the FTS definition:
  //   v0 -> v2  first-time setup
  //   v1 -> v2  the v1 FTS table declared `tags`/`entities`, but external-content
  //             mode resolves values against `memories`, which has `tags_json`/
  //             `entities_json`. Every external-content read failed with
  //             "no such column: T.tags", so the store silently fell back to LIKE.
  // Both cases are handled by rebuilding the table outright.
  try {
    db.transaction(() => rebuildFts(db))();
  } catch (err) {
    // Leave schema_version alone so the next open retries the repair rather than
    // recording a version whose FTS half never landed. Safe while the FTS rebuild
    // is the only work in this migration — revisit if a later version adds more.
    log.error("FTS5 setup failed; search is running on the degraded LIKE fallback", {
      error: String(err),
      from: current,
      to: SCHEMA_VERSION,
    });
    return;
  }

  setVersion(db, SCHEMA_VERSION);
  if (current === 0) {
    log.info("SQLite schema initialized", { version: SCHEMA_VERSION });
  } else {
    log.info("SQLite schema migrated", { from: current, to: SCHEMA_VERSION });
  }
}
