/**
 * Labeled pair corpus for merge / conflict behaviour.
 *
 * Shared by tests/conflict-classification.test.ts (does the write path put each
 * pair in the right bucket?) and tests/merge-safety.test.ts (can a threshold
 * separate the classes on the similarity scale?).
 *
 * Every pair is written the way an agent would actually retain it. Keep the
 * classes balanced when extending: it is the DISTINCT and CONFLICT rows that
 * constrain the merge threshold, and a corpus of duplicates alone will happily
 * justify a dangerous one.
 */

export interface LabeledPair {
  a: string;
  b: string;
  /** Why the pair is labeled the way it is, for failure messages. */
  note: string;
}

/**
 * Same fact, reworded. Merging is correct; leaving them split is bloat.
 */
export const DUPLICATE: LabeledPair[] = [
  {
    a: "Use TypeScript strict mode across the monorepo",
    b: "Use TypeScript strict mode across all the monorepo packages",
    note: "the pair from the 0.2.1 smoke test",
  },
  {
    a: "The team standup is at 9:30am every weekday",
    b: "Team standup is at 9:30am on every weekday",
    note: "article and preposition churn only",
  },
  {
    a: "Prefer pnpm over npm for installs",
    b: "Prefer pnpm over npm for package installs",
    note: "one added qualifier",
  },
  {
    a: "Deployed the billing service to production from the release-42 branch",
    b: "Deployed the billing service to production from the release-42 branch on Thursday",
    note: "trailing detail added",
  },
  {
    a: "Retries use exponential backoff capped at 30 seconds",
    b: "Retries use exponential backoff capped at 30 seconds across all workers",
    note: "scope phrase added, same claim",
  },
  {
    a: "The staging API base URL is https://staging.example.com/v1 for all clients",
    b: "The staging API base URL is https://staging.example.com/v1 for clients",
    note: "identical URL, same environment",
  },
  {
    a: "The on-call rotation handover happens every Tuesday at 10:00",
    b: "On-call rotation handover happens every Tuesday at 10:00 sharp",
    note: "leading article dropped, adverb added",
  },
];

/**
 * Same subject, different value. One of these has to lose — supersede.
 */
export const CONFLICT: LabeledPair[] = [
  {
    a: "The primary application database is postgres",
    b: "The primary application database is mysql",
    note: "classic conflicting_values",
  },
  {
    a: "Telemetry upload for the desktop client: enabled in production",
    b: "Telemetry upload for the desktop client: disabled in production",
    note: "boolean_flip",
  },
  {
    a: "The production API base URL is https://api.example.com/v1",
    b: "The production API base URL is https://api2.example.com/v1",
    note: "same environment, different URL — needs whole-URL slot extraction",
  },
  {
    a: "The deploy target is fly.io for the backend service",
    b: "The deploy target is render.com for the backend service",
    note: "bare domains as values",
  },
  {
    a: "The cache runs on redis version 7",
    b: "The cache runs on memcached version 1",
    note: "alias-normalized value conflict",
  },
  {
    a: "Support email is help@example.com",
    b: "Support email is support@example.com",
    note: "email as a slot value",
  },
];

/**
 * Different subjects. Both true at once — never merge, never supersede.
 * These are the rows that make a naive threshold destructive.
 */
export const SCOPE_DISTINCT: LabeledPair[] = [
  {
    a: "The staging API base URL is https://staging.example.com/v1",
    b: "The production API base URL is https://api.example.com/v1",
    note: "the pair merge was deleting at the 0.82 default",
  },
  {
    a: "The staging database is postgres 15",
    b: "The production database is postgres 16",
    note: "same software, different environment",
  },
  {
    a: "The dev environment uses sqlite for storage",
    b: "The production environment uses postgres for storage",
    note: "dev/production alias forms",
  },
  {
    a: "The primary database accepts writes",
    b: "The replica database accepts reads",
    note: "replica-role scope, not an environment",
  },
  {
    a: "The iOS client caches tokens in the keychain",
    b: "The Android client caches tokens in the keystore",
    note: "platform scope",
  },
  {
    a: "The staging worker polls the queue every 30 seconds",
    b: "The production worker polls the queue every 5 seconds",
    note: "same template, different environment and value",
  },
];

/**
 * Different facts with no scope vocabulary to catch them. Nothing classifies
 * these as conflicting — they are protected only by being lexically far apart,
 * which is exactly why the merge threshold cannot be lowered freely.
 */
export const UNRELATED: LabeledPair[] = [
  {
    a: "The team standup is at 9:30am every weekday",
    b: "The team retro is at 4:00pm every Friday",
    note: "shared frame, different event",
  },
  {
    a: "Deploy the web app with Vercel",
    b: "Deploy the worker with Fly.io",
    note: "shared verb, different component",
  },
  {
    a: "Prefer pnpm over npm for installs",
    b: "Prefer vitest over jest for tests",
    note: "shared 'prefer X over Y' frame",
  },
  {
    a: "The billing service owner is the payments team",
    b: "The search service owner is the discovery team",
    note: "shared ownership frame",
  },
  {
    a: "Retries use exponential backoff capped at 30 seconds",
    b: "Timeouts use a fixed budget capped at 10 seconds",
    note: "shared shape, different mechanism",
  },
];

/** Pairs that must never end up collapsed into one row, whatever the reason. */
export const MUST_NOT_COLLAPSE: LabeledPair[] = [
  ...SCOPE_DISTINCT,
  ...UNRELATED,
];
