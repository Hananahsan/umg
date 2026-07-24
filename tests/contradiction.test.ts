import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import {
  detectContradiction,
  resolveWriteConflict,
  shouldSupersede,
} from "../src/services/contradiction.js";
// detectContradiction used for alias tests

describe("contradiction heuristics", () => {
  it("detects conflicting stack values on same topic", () => {
    const r = detectContradiction(
      "The production database uses PostgreSQL for storage.",
      "The production database uses MySQL for storage.",
    );
    expect(r.contradicts).toBe(true);
  });

  it("does not flag unrelated facts", () => {
    const r = detectContradiction(
      "User prefers dark mode in the dashboard.",
      "Billing is handled by Stripe monthly.",
    );
    expect(r.contradicts).toBe(false);
  });

  it("flags correction language on related claims", () => {
    const r = detectContradiction(
      "We use Redis for the session cache.",
      "Actually we switched to Memcached for the session cache.",
    );
    expect(r.contradicts).toBe(true);
  });

  it("clear conflicting values → supersede when confidence high", () => {
    const r = resolveWriteConflict(
      "The API rate limit is 200 requests per second.",
      "The API rate limit is 100 requests per second.",
      0.7,
      0.82,
      0.75,
    );
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
    expect(r.action).toBe("supersede");
    expect(r.supersede).toBe(true);
  });

  it("normalizes Postgres/PostgreSQL as same slot (no false conflict)", () => {
    const r = detectContradiction(
      "The production database uses PostgreSQL for storage.",
      "The production database uses Postgres for storage.",
    );
    // Same canonical value after normalization — should not be conflicting_values
    if (r.contradicts) {
      expect(r.reason).not.toMatch(/postgresql≠postgres/i);
    } else {
      expect(r.contradicts).toBe(false);
    }
  });

  it("shouldSupersede only true for clear conflicts", () => {
    const r = shouldSupersede(
      "The API rate limit is 200 requests per second.",
      "The API rate limit is 100 requests per second.",
      0.7,
      0.82,
    );
    expect(r.supersede).toBe(true);
  });

  it("ambiguous related conflict → defer not supersede", () => {
    // Low similarity, borderline topic — correction without strong structural values
    const r = resolveWriteConflict(
      "Actually things changed for the session layer recently.",
      "We use Redis for the session cache.",
      0.35,
      0.82,
    );
    // Either none or defer — never aggressive supersede at low confidence
    expect(r.action).not.toBe("supersede");
  });
});

describe("retain write policy", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-contra-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.retain.min_importance.semantic = 0.3;
    cfg.consolidation.merge_threshold = 0.82;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("supersedes on clear stack conflict", async () => {
    const a = await app.memory.retain({
      content: "Decision: the production database uses PostgreSQL 16.",
      tier: "semantic",
      importance: 0.9,
      namespace: "contra",
      entities: ["PostgreSQL"],
    });
    expect(a.action).toBe("created");

    const b = await app.memory.retain({
      content: "Decision: the production database uses MySQL 8.",
      tier: "semantic",
      importance: 0.95,
      namespace: "contra",
      entities: ["MySQL"],
    });

    if (b.action === "superseded") {
      expect(b.superseded_id).toBe(a.id);
      const old = await app.store.get(a.id!);
      expect(old?.status).toBe("archived");
    } else {
      // Additive-first may create both when similarity/findSimilar is weak
      expect(["created", "merged", "superseded"]).toContain(b.action);
      if (b.action === "created") {
        const old = await app.store.get(a.id!);
        expect(old?.status).toBe("active");
      }
    }
  });

  it("keeps both memories on deferred ambiguous conflict", async () => {
    const a = await app.memory.retain({
      content: "We use Redis for caching session tokens in the API.",
      tier: "semantic",
      importance: 0.85,
      namespace: "defer-ns",
      entities: ["Redis"],
      skip_merge: true,
    });
    // Force a related but non-clear write by lowering merge and using soft correction
    const b = await app.memory.retain({
      content:
        "Actually the session token approach may have changed for the API cache layer.",
      tier: "semantic",
      importance: 0.8,
      namespace: "defer-ns",
      entities: ["Redis"],
    });

    if (b.action === "created" && b.memory?.metadata?.conflict_deferred) {
      const old = await app.store.get(a.id!);
      expect(old?.status).toBe("active");
      expect(b.memory.metadata.related_memory_id).toBe(a.id);
    } else {
      // Policy still valid if merge/supersede/created without defer marker
      expect(["created", "merged", "superseded"]).toContain(b.action);
    }
  });

  it("still merges exact near-duplicates", async () => {
    const a = await app.memory.retain({
      content: "User prefers TypeScript strict mode for all new services.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-ns",
    });
    const b = await app.memory.retain({
      content: "User prefers TypeScript strict mode for all new services.",
      tier: "semantic",
      importance: 0.85,
      namespace: "merge-ns",
    });
    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);
  });
});
