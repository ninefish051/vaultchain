import Fastify from "fastify";
import cors from "@fastify/cors";
import Anthropic from "@anthropic-ai/sdk";
import { z, ZodError } from "zod";
import { MODEL, runBuyerAgent } from "./agent";
import { respondToOffer } from "./sellerAgent";

const app = Fastify({ logger: true });
await app.register(cors, { origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",") });

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(40),
  userAddress: z.string().optional(),
  limits: z
    .object({
      maxPerOrderUsd: z.number().positive().optional(),
      totalBudgetUsd: z.number().positive().optional(),
      allowedGraders: z.array(z.string()).optional(),
    })
    .optional(),
});

app.get("/health", async () => ({ ok: true, model: MODEL }));

/** Buyer agent turn. The client keeps the transcript (text only) and sends it each time. */
app.post("/chat", async (req, reply) => {
  try {
    const b = chatBody.parse(req.body);
    if (b.messages[0]!.role !== "user") return reply.status(400).send({ error: "first message must be from the user" });
    return await runBuyerAgent(b);
  } catch (e) {
    if (e instanceof ZodError) return reply.status(400).send({ error: "invalid_request", issues: e.issues });
    if (e instanceof Anthropic.RateLimitError) return reply.status(429).send({ error: "The agent is busy, try again shortly" });
    if (e instanceof Anthropic.AuthenticationError) return reply.status(503).send({ error: "Agent is not configured (ANTHROPIC_API_KEY)" });
    if (e instanceof Anthropic.APIError) {
      req.log.error(e);
      return reply.status(502).send({ error: `Model API error ${e.status}` });
    }
    throw e;
  }
});

/** Seller agent endpoint for other agents (A2A): respond to an offer on a listing. */
app.post("/seller/respond", async (req, reply) => {
  const b = z
    .object({ askUsd: z.number().positive(), fairValueUsd: z.number().positive().optional(), sellerFloorUsd: z.number().positive().optional(), offerUsd: z.number().positive() })
    .safeParse(req.body);
  if (!b.success) return reply.status(400).send({ error: "invalid_request" });
  const { offerUsd, ...policy } = b.data;
  return respondToOffer(policy, offerUsd);
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4100) });
