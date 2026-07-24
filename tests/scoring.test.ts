import { describe, it, expect } from "vitest";
import {
  autoTier,
  computeImportance,
  isLowInformation,
} from "../src/services/scoring.js";

describe("scoring helpers", () => {
  it("detects low information", () => {
    expect(isLowInformation("ok")).toBe(true);
    expect(isLowInformation("hello")).toBe(true);
    expect(
      isLowInformation("User prefers TypeScript for all backend services"),
    ).toBe(false);
  });

  it("boosts remember language", () => {
    const base = computeImportance("The API timeout is 30 seconds", "semantic");
    const boosted = computeImportance(
      "Remember: the API timeout is always 30 seconds",
      "semantic",
    );
    expect(boosted).toBeGreaterThan(base);
  });

  it("auto tiers skills as procedural", () => {
    expect(autoTier("How to rotate Retell API keys: step 1 login")).toBe(
      "procedural",
    );
  });

  it("auto tiers preferences as semantic", () => {
    expect(autoTier("User prefers dark mode always")).toBe("semantic");
  });
});
