import { describe, expect, it } from "vitest";
import { DEMO_CARDS } from "@vaultchain/shared";
import { titleMatches } from "../src/match";

const charizard10 = DEMO_CARDS.find((c) => c.name === "Charizard" && c.grade === "10")!;

describe("titleMatches", () => {
  it("accepts the exact card and grade", () => {
    expect(titleMatches(charizard10, "1999 Pokemon Base Set Charizard Holo #4 PSA 10 GEM MINT")).toBe(true);
    expect(titleMatches(charizard10, "Charizard 4/102 Base Unlimited PSA GEM MT 10")).toBe(true);
  });
  it("rejects other grades, graders, lots and reprints", () => {
    expect(titleMatches(charizard10, "1999 Pokemon Base Set Charizard Holo #4 PSA 9 MINT")).toBe(false);
    expect(titleMatches(charizard10, "Charizard #4 Base Set BGS 10 pristine")).toBe(false);
    expect(titleMatches(charizard10, "Charizard #4 PSA 10 lot of 3")).toBe(false);
    expect(titleMatches(charizard10, "Charizard #4 PSA 10 custom proxy")).toBe(false);
    expect(titleMatches(charizard10, "Blastoise #2 PSA 10")).toBe(false);
    expect(titleMatches(charizard10, "Charizard #44 PSA 10")).toBe(false);
  });
});
