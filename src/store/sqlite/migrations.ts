import type Database from "better-sqlite3";
import { SCHEMA_SQL, FTS_SQL, SCHEMA_VERSION } from "./schema.js";
import { log } from "../../util/log.js";

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;

  const current = row ? Number(row.value) : 0;

  if (current < 1) {
    // Ensure FTS exists
    try {
      db.exec(FTS_SQL);
    } catch (err) {
      log.warn("FTS setup issue (will fall back to LIKE search)", {
        error: String(err),
      });
    }
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
    log.info("SQLite schema initialized", { version: SCHEMA_VERSION });
  } else if (current < SCHEMA_VERSION) {
    // Future migrations go here
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
    log.info("SQLite schema migrated", { from: current, to: SCHEMA_VERSION });
  }
}
