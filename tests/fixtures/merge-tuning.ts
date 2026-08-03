/**
 * Thresholds for tests that exercise merge *mechanics* — lineage, multi-pass
 * convergence, dry-run parity, tier preservation, the composed write path.
 *
 * These pin explicitly instead of reading the shipped default, because the
 * shipped default is a policy decision that moves independently: it currently
 * sits at 0.95, high enough that merge effectively does not fire. A test that
 * read the default would silently stop covering the algorithm the moment the
 * policy changed — which is exactly how a suite goes green while the thing it
 * claims to test is dead.
 *
 * Policy itself is asserted separately, against the real default, in
 * tests/merge-safety.test.ts.
 */
export const MECHANICS_MERGE_THRESHOLD = 0.5;
export const MECHANICS_MERGE_MIN_CONFIDENCE = 0.5;
