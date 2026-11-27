import { keccak256, toBytes, type Hex } from "viem";

export const GRADERS = ["PSA", "BGS", "CGC"] as const;
export type Grader = (typeof GRADERS)[number];

/** Identity of a card *type* at a given grade. Two slabs with the same CardKey are interchangeable for pricing and "any-of" swaps. */
export interface CardIdentity {
  game: string; // "pokemon"
  set: string; // "base1"
  number: string; // "4/102"
  language: string; // "EN", "JP"
  variant: string; // "holo", "1st", "shadowless", "" for none
  grader: Grader;
  grade: string; // "10", "9.5"
}

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

/** Canonical string: lower-case game/set/variant, upper-case language/grader, numbers as given. */
export function canonicalCardString(c: CardIdentity): string {
  return [
    clean(c.game).toLowerCase(),
    clean(c.set).toLowerCase(),
    clean(c.number),
    clean(c.language).toUpperCase(),
    clean(c.variant).toLowerCase(),
    c.grader.toUpperCase(),
    normalizeGrade(c.grade),
  ].join("|");
}

export function normalizeGrade(grade: string): string {
  const n = Number.parseFloat(grade);
  if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error(`Invalid grade: ${grade}`);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function cardKeyOf(c: CardIdentity): Hex {
  return keccak256(toBytes(canonicalCardString(c)));
}

export function parseCardString(s: string): CardIdentity {
  const [game, set, number, language, variant, grader, grade] = s.split("|");
  if (grade === undefined) throw new Error(`Malformed card string: ${s}`);
  if (!GRADERS.includes(grader as Grader)) throw new Error(`Unsupported grader: ${grader}`);
  return { game: game!, set: set!, number: number!, language: language!, variant: variant!, grader: grader as Grader, grade };
}

/** A specific physical slab: grader + certificate number. tokenId = BigInt(slabId). */
export function slabIdOf(grader: Grader, certNumber: string): Hex {
  const cert = certNumber.replace(/\D/g, "");
  if (!cert) throw new Error("Certificate number must contain digits");
  return keccak256(toBytes(`${grader}|${cert}`));
}

export function tokenIdOf(slabId: Hex): bigint {
  return BigInt(slabId);
}
