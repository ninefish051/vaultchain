import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page is a client component that fetches from the API, so no incremental cache is needed.
export default defineCloudflareConfig();
