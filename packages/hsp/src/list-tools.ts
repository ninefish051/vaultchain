// Prints the live HSP MCP tool schemas (needs an allow-listed IP).
import { HspClient } from "./index";

const hsp = new HspClient();
for (const t of await hsp.listTools()) {
  console.log(`\n## ${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.inputSchema, null, 2)}`);
}
await hsp.close();
