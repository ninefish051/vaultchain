import { carousell } from "./carousell";
import { demo } from "./demo";
import { ebayBrowse } from "./ebayBrowse";
import { ebaySold } from "./ebaySold";
import { priceCharting } from "./priceCharting";
import type { Collector } from "./types";

export const REAL_COLLECTORS: Collector[] = [ebaySold, ebayBrowse, priceCharting, carousell];
export { demo };
export type { Collector, TrackedCard } from "./types";
