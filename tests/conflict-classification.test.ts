import { describe, it, expect } from "vitest";
import {
  detectScopeDivergence,
  extractValueSlots,
  resolveWriteConflict,
} from "../src/services/contradiction.js";
import {
  CONFLICT,
  DUPLICATE,
  SCOPE_DISTINCT,
  UNRELATED,
} from "./fixtures/labeled-pairs.js";

/**
 * Which bucket does the write path put each labeled pair in?
 *
 * Similarity is passed high so every pair is treated as "related" — the point
 * is the classification, not the retrieval. A pair that classifies wrongly here
 * classifies wrongly in prune and on write too.
 */
const RELATED_SIMILARITY = 0.9;
const MERGE_THRESHOLD = 0.82;

function classify(a: string, b: string): string {
  return resolveWriteConflict(a, b, RELATED_SIMILARITY, MERGE_THRESHOLD).action;
}

describe("value slot extraction", () => {
  it("extracts whole URLs, not the scheme", () => {
    // The bug: `[\w.+#/-]*` stops at the colon, so every URL after a lead-in
    // reduced to "https" and two different URLs looked identical.
    const slots = extractValueSlots(
      "The staging API base URL is https://staging.example.com/v1",
    );
    expect(slots).toContain("https://staging.example.com/v1");
    expect(slots).not.toContain("https");
  });

  it("distinguishes two different URLs", () => {
    const a = extractValueSlots("The base URL is https://api.example.com/v1");
    const b = extractValueSlots("The base URL is https://api2.example.com/v1");
    expect(a).not.toEqual(b);
  });

  it("extracts emails, bare domains and ports", () => {
    expect(extractValueSlots("Support email is help@example.com")).toContain(
      "help@example.com",
    );
    expect(extractValueSlots("The deploy target is fly.io")).toContain("fly.io");
    expect(extractValueSlots("Postgres listens on port 5432")).toContain("5432");
  });

  it("strips trailing prose punctuation from a literal", () => {
    expect(
      extractValueSlots("The docs live at https://example.com/guide."),
    ).toContain("https://example.com/guide");
  });
});

describe("scope divergence", () => {
  it.each(SCOPE_DISTINCT)("detects $note", ({ a, b }) => {
    expect(detectScopeDivergence(a, b).diverges).toBe(true);
  });

  it("does not fire when both sides name the same scope", () => {
    expect(
      detectScopeDivergence(
        "The production API base URL is https://api.example.com/v1",
        "The production API base URL is https://api2.example.com/v1",
      ).diverges,
    ).toBe(false);
  });

  it("does not fire when neither side names a scope", () => {
    expect(
      detectScopeDivergence(
        "The primary application database is postgres",
        "The team retro is at 4:00pm",
      ).diverges,
    ).toBe(false);
  });

  it("treats alias forms as the same scope", () => {
    // prod/production and dev/development must not read as divergent.
    expect(
      detectScopeDivergence(
        "The prod database is postgres",
        "The production database is mysql",
      ).diverges,
    ).toBe(false);
  });
});

describe("write conflict classification", () => {
  it.each(CONFLICT)("supersedes: $note", ({ a, b }) => {
    expect(classify(a, b)).toBe("supersede");
  });

  it.each(SCOPE_DISTINCT)("keeps both as distinct: $note", ({ a, b }) => {
    expect(classify(a, b)).toBe("distinct");
  });

  it.each(DUPLICATE)("raises no conflict for a duplicate: $note", ({ a, b }) => {
    expect(classify(a, b)).not.toBe("supersede");
    expect(classify(a, b)).not.toBe("distinct");
  });

  it.each(UNRELATED)(
    "raises no conflict for unrelated facts: $note",
    ({ a, b }) => {
      // No signal classifies these — they are protected by lexical distance
      // alone, which is the constraint the merge threshold has to respect.
      expect(classify(a, b)).not.toBe("supersede");
    },
  );
});
