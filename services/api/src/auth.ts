import type { FastifyRequest } from "fastify";
import { keccak256, recoverMessageAddress, toBytes, type Address, type Hex } from "viem";

/**
 * Wallet-signed requests for writes. The client signs (personal_sign):
 *
 *   VaultChain API
 *   <METHOD> <path>
 *   <unix seconds>
 *   <keccak256 of the raw JSON body, or 0x0 for none>
 *
 * and sends x-vc-address, x-vc-timestamp, x-vc-signature. Valid for 5 minutes.
 * apps/web builds the same string in lib/api.ts (signedRequestMessage).
 */
export function signedRequestMessage(method: string, path: string, timestamp: string, body: string | undefined) {
  const bodyHash = body ? keccak256(toBytes(body)) : "0x0";
  return `VaultChain API\n${method.toUpperCase()} ${path}\n${timestamp}\n${bodyHash}`;
}

export class AuthError extends Error {
  statusCode = 401;
}

export async function requireSigner(req: FastifyRequest): Promise<Address> {
  const address = req.headers["x-vc-address"] as string | undefined;
  const timestamp = req.headers["x-vc-timestamp"] as string | undefined;
  const signature = req.headers["x-vc-signature"] as Hex | undefined;
  if (!address || !timestamp || !signature) throw new AuthError("Missing wallet signature headers");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new AuthError("Signature expired");
  const path = req.url.split("?")[0]!;
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody || undefined;
  const recovered = await recoverMessageAddress({ message: signedRequestMessage(req.method, path, timestamp, raw), signature });
  if (recovered.toLowerCase() !== address.toLowerCase()) throw new AuthError("Signature does not match address");
  return recovered;
}

const vaultAdmins = () =>
  (process.env.VAULT_ADMINS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

export async function requireVaultAdmin(req: FastifyRequest): Promise<Address> {
  const a = await requireSigner(req);
  if (!vaultAdmins().includes(a.toLowerCase())) {
    const e = new AuthError("Not a vault operator");
    e.statusCode = 403;
    throw e;
  }
  return a;
}
