import type { CardType } from "@vaultchain/shared";

const BLOCK = /\b(lot|bundle|proxy|custom|reprint|fake|replica|orica|digital|code card|empty slab|label only|read description|pick|choose)\b/i;
const GRADERS = ["PSA", "BGS", "BECKETT", "CGC", "SGC", "TAG", "ACE"];

/** Search query for marketplaces. */
export function searchQuery(card: CardType & { searchQuery?: string }): string {
  if (card.searchQuery) return card.searchQuery;
  const num = card.number.split("/")[0];
  return `${card.name.replace(/\(.*?\)/g, "").trim()} ${card.setName} ${num} ${card.grader} ${card.grade}`;
}

/**
 * Accepts a listing title only if it is clearly this card at this grade from this grader:
 * card number present, grader present, exact grade (e.g. "PSA 10" but not "PSA 9" or "10 GEM MINT" from BGS).
 */
export function titleMatches(card: CardType, title: string): boolean {
  if (BLOCK.test(title)) return false;
  const t = title.toUpperCase().replace(/\s+/g, " ");
  const num = card.number.split("/")[0]!.replace(/^0+/, "");
  if (!new RegExp(`(^|[^0-9])0*${num}([^0-9]|$)`).test(t)) return false;
  const grader = card.grader === "BGS" ? "(BGS|BECKETT)" : card.grader;
  const grade = card.grade.replace(".", "\\.");
  if (!new RegExp(`${grader}\\s*(GEM\\s*(MT|MINT)\\s*)?${grade}(?![0-9.])`).test(t)) return false;
  // reject titles naming a different grader too (cross-graded lots)
  const others = GRADERS.filter((g) => g !== card.grader && !(card.grader === "BGS" && g === "BECKETT"));
  if (others.some((g) => new RegExp(`\\b${g}\\s*\\d`).test(t))) return false;
  const nameWord = card.name.split(/[ (]/)[0]!.toUpperCase();
  return t.includes(nameWord);
}
