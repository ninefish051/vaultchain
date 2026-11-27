import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { getDb, hasDb, migrate } from "@vaultchain/db";
import { createDemoStore } from "./store/demo";
import { createPgStore } from "./store/pg";
import { registerRoutes } from "./routes";
import { startIndexer } from "./indexer";
import { tryChain } from "./chain";

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "warn" : "info") } });

  // Keep the raw JSON body: write requests are signed over its exact bytes (see auth.ts).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(","),
    allowedHeaders: ["content-type", "x-vc-address", "x-vc-timestamp", "x-vc-signature"],
    methods: ["GET", "POST", "DELETE"],
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid_request", issues: err.issues });
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(e);
    return reply.status(status).send({ error: status === 500 ? "internal_error" : e.message });
  });

  let store;
  if (hasDb()) {
    const db = getDb();
    await migrate(db);
    store = createPgStore(db);
    if (tryChain() && process.env.INDEXER_ENABLED !== "false") startIndexer(db, (m) => app.log.info(m), (m) => app.log.error(m));
  } else {
    app.log.warn("DATABASE_URL not set: serving the in-memory demo catalogue");
    store = createDemoStore();
  }
  registerRoutes(app, store);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4000) });
}
