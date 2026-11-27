import { closeDb, migrate } from "./index";

await migrate();
await closeDb();
