import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for personal data at rest (shipping addresses). The key comes from
 * SHIPPING_ENC_KEY (32 bytes, hex or base64), loaded from AWS Secrets Manager in production.
 * Ciphertext format: base64(iv[12] | tag[16] | data).
 */
function key(): Buffer {
  const raw = process.env.SHIPPING_ENC_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("SHIPPING_ENC_KEY is not set");
    return Buffer.alloc(32, 7); // development only
  }
  const k = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("SHIPPING_ENC_KEY must be 32 bytes");
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
