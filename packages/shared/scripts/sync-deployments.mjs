// Copies contracts/deployments/<chainId>.json into src/deployments.json (keyed by chainId).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../../contracts/deployments");
const all = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  all[String(d.chainId)] = d;
}
writeFileSync(join(here, "../src/deployments.json"), JSON.stringify(all, null, 2) + "\n");
console.log(`Synced deployments for chains: ${Object.keys(all).join(", ") || "(none)"}`);
