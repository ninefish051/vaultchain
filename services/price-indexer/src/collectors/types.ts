import type { CardType } from "@vaultchain/shared";
import type { NewSample } from "@vaultchain/db";

export type TrackedCard = CardType & { searchQuery?: string };

export interface Collector {
  name: string;
  enabled(): boolean;
  collect(card: TrackedCard): Promise<NewSample[]>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
