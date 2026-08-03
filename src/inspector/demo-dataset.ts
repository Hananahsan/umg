import { createApp, type UmgApp } from "../app.js";
import { defaultConfig, type UmgConfig } from "../config.js";
import { SqliteMemoryStore } from "../store/sqlite/store.js";
import { ReadOnlyStore } from "../store/readonly.js";
import type { MemoryService } from "../services/memory.js";
import type { MemoryStore } from "../store/interface.js";

export const DEMO_NAMESPACE = "demo";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Config for the synthetic dataset. Caps are deliberately small so cap
 * pressure fires on ~60 memories instead of the 2000 the real defaults need.
 * auto_promote is off so the replay shows the four levers and nothing else.
 */
export function demoConfig(): UmgConfig {
  const cfg = defaultConfig();
  cfg.db_path = ":memory:";
  cfg.default_namespace = DEMO_NAMESPACE;
  cfg.consolidation.caps = {
    working: 8,
    episodic: 20,
    semantic: 25,
    procedural: 3,
    global: 60,
  };
  cfg.consolidation.auto_promote = false;
  cfg.consolidation.light_prune_every_n_writes = 0;
  cfg.retain.min_importance = {
    working: 0.05,
    episodic: 0.1,
    semantic: 0.2,
    procedural: 0.3,
  };
  return cfg;
}

/**
 * Build a read-only app over a synthetic in-memory dataset.
 *
 * Seeding goes through the real `retain` write path so importance, entities
 * and decay come from the production heuristics rather than hand-set numbers.
 * The database is `:memory:` and is never written to disk.
 */
export async function createDemoApp(): Promise<UmgApp> {
  const cfg = demoConfig();
  const writable = new SqliteMemoryStore(":memory:", cfg);
  const seeding = createApp({ cfg, store: writable });
  await seed(seeding.memory, writable);
  return createApp({ cfg, store: new ReadOnlyStore(writable) });
}

interface SeedSpec {
  content: string;
  tier: "working" | "episodic" | "semantic" | "procedural";
  importance?: number;
  /** Backdate last_accessed_at / created_at by this many days. */
  ageDays?: number;
  accessCount?: number;
  /** Force expires_at into the past. */
  expired?: boolean;
  tags?: string[];
}

async function seed(
  memory: MemoryService,
  store: MemoryStore,
): Promise<void> {
  for (const spec of SEEDS) {
    const result = await memory.retain({
      content: spec.content,
      tier: spec.tier,
      importance: spec.importance,
      namespace: DEMO_NAMESPACE,
      tags: spec.tags,
      source: "demo",
      skip_merge: true,
    });
    if (!result.id) continue;
    if (!spec.ageDays && spec.accessCount === undefined && !spec.expired) {
      continue;
    }

    // store.update() treats created_at as immutable, and the score-floor step
    // measures age from created_at against the grace period. Re-put the whole
    // record so aged memories are genuinely aged rather than faking it by
    // zeroing grace_period_days in the demo config.
    const seeded = await store.get(result.id);
    if (!seeded) continue;

    const aged = spec.ageDays
      ? new Date(Date.now() - spec.ageDays * DAY_MS).toISOString()
      : null;

    await store.delete(seeded.id);
    await store.put({
      ...seeded,
      created_at: aged ?? seeded.created_at,
      last_accessed_at: aged ?? seeded.last_accessed_at,
      updated_at: aged ?? seeded.updated_at,
      access_count: spec.accessCount ?? seeded.access_count,
      expires_at: spec.expired
        ? new Date(Date.now() - 2 * DAY_MS).toISOString()
        : seeded.expires_at,
    });
  }
}

/**
 * Planted so a dry run produces at least one of every operation:
 *   merge · supersede · expire · score_floor · cap_tier · cap_skip_procedural
 *
 * Importance values on duplicate clusters are deliberately distinct so
 * pickMergeTarget resolves the same way on every run (the replay must be
 * byte-identical when re-recorded).
 */
const SEEDS: SeedSpec[] = [
  // ---- near-duplicate cluster → merge (semantic) --------------------------
  {
    content:
      "The staging API base URL is https://staging.example.com/v1 for all clients.",
    tier: "semantic",
    importance: 0.82,
  },
  {
    content:
      "The staging API base URL is https://staging.example.com/v1 for clients.",
    tier: "semantic",
    importance: 0.78,
  },
  {
    // Kept within one token of the others: Jaccard drops fast. These three
    // score ~0.93 and so no longer merge at the 0.95 safety threshold — they
    // are left in as the visible "duplicates the engine is currently leaving
    // alone" case. The episodic pair below is the one that still collapses.
    content:
      "The staging API base URL is https://staging.example.com/v1 for all clients today.",
    tier: "semantic",
    importance: 0.74,
  },

  // ---- near-duplicate pair → merge (episodic) -----------------------------
  // Two constraints shape this pair:
  //  - no negation words ("without", "no longer"): those trip the
  //    contradiction detector and turn a duplicate into a supersede;
  //  - findSimilar scores jaccard*0.85 + entity*0.15, so clearing the merge
  //    threshold needs the same token set. A reordered paraphrase does exactly
  //    that, scoring 1.0 — which keeps it merging even at the 0.95 safety
  //    threshold, so the replay always has a merge to show.
  {
    content:
      "Deployed the billing service to production from the release-42 branch on Thursday.",
    tier: "episodic",
    importance: 0.62,
    accessCount: 2,
  },
  {
    content:
      "On Thursday, deployed the billing service to production from the release-42 branch.",
    tier: "episodic",
    importance: 0.58,
    accessCount: 1,
  },

  // ---- contradiction → supersede (conflicting_values) ---------------------
  {
    content: "The primary application database is postgres running version 16.",
    tier: "semantic",
    importance: 0.7,
    ageDays: 40,
    accessCount: 3,
  },
  {
    content: "The primary application database is mysql running version 8.",
    tier: "semantic",
    importance: 0.86,
    accessCount: 6,
  },

  // ---- contradiction → supersede (boolean_flip) ---------------------------
  {
    content: "Telemetry upload for the desktop client: enabled in production.",
    tier: "semantic",
    importance: 0.64,
    ageDays: 30,
  },
  {
    content: "Telemetry upload for the desktop client: disabled in production.",
    tier: "semantic",
    importance: 0.8,
    accessCount: 4,
  },

  // ---- healthy semantic facts that survive the run ------------------------
  {
    content:
      "Remember: the team prefers TypeScript strict mode on every new package.",
    tier: "semantic",
    importance: 0.88,
    accessCount: 9,
  },
  {
    content:
      "Decision: retries use exponential backoff capped at 30 seconds across all workers.",
    tier: "semantic",
    importance: 0.84,
    accessCount: 5,
  },
  {
    content:
      "The on-call rotation handover happens every Tuesday at 10:00 Europe/London.",
    tier: "semantic",
    importance: 0.76,
    accessCount: 4,
  },
  {
    content:
      "Remember: customer-facing error copy is reviewed by support before release.",
    tier: "semantic",
    importance: 0.72,
    accessCount: 3,
  },

  // ---- stale episodic → score_floor eviction ------------------------------
  ...staleEpisodes(),

  // ---- expired working memories → expire ----------------------------------
  {
    content: "Scratch: currently checking why the nightly export job ran twice.",
    tier: "working",
    importance: 0.3,
    expired: true,
  },
  {
    content: "Scratch: today's todo is to finish the pagination cursor rewrite.",
    tier: "working",
    importance: 0.3,
    expired: true,
  },

  // ---- working tier over cap (8) → cap_tier eviction ----------------------
  ...workingScratch(),

  // ---- procedural over cap (3), protected → cap_skip_procedural -----------
  ...skills(),
];

function staleEpisodes(): SeedSpec[] {
  const topics = [
    "Reviewed the quarterly infrastructure spend spreadsheet with finance.",
    "Debugged a flaky integration test in the notifications package.",
    "Paired on the legacy CSV importer to understand its column mapping.",
    "Attended the vendor demo for the log aggregation product.",
    "Triaged eleven stale issues in the mobile repository backlog.",
    "Walked a new contractor through the local development setup.",
    "Investigated a one-off timeout in the webhook delivery worker.",
  ];
  return topics.map((content, i) => ({
    content,
    tier: "episodic" as const,
    importance: 0.4,
    // 180+ days at a 14-day half-life puts decay far under the 0.12 floor
    ageDays: 180 + i * 12,
    accessCount: 0,
  }));
}

function workingScratch(): SeedSpec[] {
  const topics = [
    "resolving the duplicate-webhook bug in the payments adapter",
    "drafting the migration plan for the accounts table split",
    "measuring cold start latency on the search endpoint",
    "reproducing the Safari layout glitch on the settings page",
    "auditing which cron jobs still write to the legacy queue",
    "sketching the retry semantics for the outbound mailer",
    "collecting sample payloads from the partner sandbox",
    "checking whether the CDN purge actually invalidated assets",
    "listing the endpoints that still lack request validation",
    "comparing bundle size before and after the icon refactor",
    "reading through the incident timeline from last Thursday",
    "verifying the staging seed script still produces valid data",
    "tracing a memory growth pattern in the ingest worker",
    "writing down the open questions for the schema review",
  ];
  return topics.map((topic, i) => ({
    content: `Scratch note ${i + 1}: currently ${topic}.`,
    tier: "working" as const,
    // Spread importance so eviction order is stable, not tie-broken by time
    importance: 0.2 + (i % 7) * 0.03,
  }));
}

function skills(): SeedSpec[] {
  const bodies = [
    {
      title: "database migration rollout",
      steps: [
        "Run the migration against a staging clone first.",
        "Deploy code that tolerates both schemas.",
        "Backfill in batches, then drop the old column.",
      ],
    },
    {
      title: "production incident triage",
      steps: [
        "Declare the incident and name a single coordinator.",
        "Stop the bleeding before diagnosing the cause.",
        "Write the timeline while the details are fresh.",
      ],
    },
    {
      title: "dependency upgrade sweep",
      steps: [
        "Upgrade one ecosystem at a time, never all at once.",
        "Read the changelog for every major version bump.",
        "Land the lockfile change in its own commit.",
      ],
    },
    {
      title: "flaky test quarantine",
      steps: [
        "Quarantine the test the same day it is spotted.",
        "Attach the failing seed and the run link.",
        "Delete the test if nobody claims it in two weeks.",
      ],
    },
    {
      title: "public API deprecation",
      steps: [
        "Announce the deprecation one full release ahead.",
        "Emit a warning header on every deprecated response.",
        "Keep the shim until usage reaches zero for 30 days.",
      ],
    },
  ];
  return bodies.map((b, i) => ({
    content: [
      `Skill: ${b.title}`,
      `When to use: ${b.title} work in any service.`,
      "Lessons:",
      ...b.steps.map((s, n) => `${n + 1}. ${s}`),
    ].join("\n"),
    tier: "procedural" as const,
    importance: 0.9 - i * 0.02,
    accessCount: 5 - i,
  }));
}
