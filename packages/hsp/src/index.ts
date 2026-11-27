import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Client for the HSP (HashKey Settlement Platform) Agentic Payment MCP server.
 *
 * Flow (from the HSP Agentic Payment Guide):
 *   get_chain_config → create_order(merchant_name, pay_to, cart_mandate) → { flow_id, payment_request_id }
 *   → prepare_payment(flow_id, payer, protocol) → eip712 + payment_payload + payment_mandate_contents + cart_hash
 *   → payer wallet signs the eip712 data (in the browser, never server-side)
 *   → finalize_payment(signature, payment_payload, payment_mandate_contents, cart_hash) → payment_mandate_json
 *   → submit_payment(payment_mandate_json) → query_payment every 15s until payment-finalized | payment-failed.
 *
 * The server requires the caller's public IP to be allow-listed, so this only works from the
 * VaultChain EC2 instance (Elastic IP). Argument names below follow the guide; the live tool
 * schemas are authoritative — run `pnpm --filter @vaultchain/hsp tools` to print them.
 */

export const HSP_MCP_URL = process.env.HSP_MCP_URL ?? "https://mcp-qa.hashkeymerchant.com/";

export type HspStatus =
  | "payment-submitted"
  | "payment-verified"
  | "payment-processing"
  | "payment-included"
  | "payment-timeout"
  | "payment-safe"
  | "payment-finalized"
  | "payment-failed";

/** Only payment-finalized is irreversible; payment-safe is NOT final. */
export const FINAL_SUCCESS: HspStatus = "payment-finalized";
export const isTerminal = (s: string) => s === "payment-finalized" || s === "payment-failed";

export interface CreateOrderResult {
  flow_id: string;
  payment_request_id: string;
  payment_url?: string;
  [k: string]: unknown;
}

export interface PreparePaymentResult {
  eip712: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  payment_payload: unknown;
  payment_mandate_contents: unknown;
  cart_hash: string;
  token_total_raw?: string;
  pay_to?: string;
  [k: string]: unknown;
}

export interface QueryPaymentResult {
  status: HspStatus | string;
  payment?: { status?: string; status_reason?: string; tx_signature?: string; [k: string]: unknown };
  attribution_verified?: boolean;
  [k: string]: unknown;
}

export class HspError extends Error {
  constructor(public tool: string, message: string, public raw?: unknown) {
    super(`HSP ${tool}: ${message}`);
  }
}

export class HspClient {
  private client?: Client;

  constructor(private url = HSP_MCP_URL, private merchantName = process.env.HSP_MERCHANT_NAME ?? "VaultChain") {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "vaultchain", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close();
    this.client = undefined;
  }

  async listTools() {
    const c = await this.connect();
    return (await c.listTools()).tools;
  }

  /** Calls a tool and parses its JSON result (structuredContent, or the first text block). */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const c = await this.connect();
    const res = await c.callTool({ name: tool, arguments: args });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content.find((b) => b.type === "text")?.text;
    if (res.isError) throw new HspError(tool, text ?? "tool returned an error", res);
    if (res.structuredContent) return res.structuredContent as T;
    if (!text) throw new HspError(tool, "empty result", res);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HspError(tool, `non-JSON result: ${text.slice(0, 200)}`, res);
    }
  }

  getChainConfig() {
    return this.call("get_chain_config");
  }

  /**
   * Creates a USD-denominated cart paying `payTo` (the escrow contract).
   * `methodData` must come from get_chain_config (x402 v2, network + token).
   */
  createOrder(input: { payTo: string; amountUsd: string; cartId: string; label: string; methodData: unknown[]; expiresInSec?: number }) {
    const expiry = new Date(Date.now() + (input.expiresInSec ?? 15 * 60) * 1000).toISOString();
    return this.call<CreateOrderResult>("create_order", {
      merchant_name: this.merchantName,
      pay_to: input.payTo,
      cart_mandate: {
        contents: {
          id: input.cartId,
          cart_expiry: expiry,
          payment_request: {
            method_data: input.methodData,
            details: {
              id: input.cartId,
              display_items: [{ label: input.label, amount: { currency: "USD", value: input.amountUsd } }],
              total: { label: "Total", amount: { currency: "USD", value: input.amountUsd } },
            },
          },
        },
      },
    });
  }

  getOrder(flowId: string) {
    return this.call("get_order", { flow_id: flowId });
  }

  preparePayment(flowId: string, payer: string, protocol: "eip3009" | "permit2" = "eip3009") {
    return this.call<PreparePaymentResult>("prepare_payment", { flow_id: flowId, payer_address: payer, protocol });
  }

  finalizePayment(input: { signature: string; payment_payload: unknown; payment_mandate_contents: unknown; cart_hash: string }) {
    return this.call<{ payment_mandate_json: unknown }>("finalize_payment", input);
  }

  estimateFee(args: Record<string, unknown>) {
    return this.call("estimate_fee", args);
  }

  submitPayment(paymentMandateJson: unknown) {
    return this.call("submit_payment", { payment_mandate_json: paymentMandateJson });
  }

  async queryPayment(flowId: string, paymentRequestId: string): Promise<QueryPaymentResult> {
    const r = await this.call<QueryPaymentResult>("query_payment", {
      flow_id: flowId,
      payment_request_id: paymentRequestId,
      expected_merchant_name: this.merchantName,
    });
    const status = (r.status ?? r.payment?.status ?? "unknown") as string;
    return { ...r, status };
  }
}
