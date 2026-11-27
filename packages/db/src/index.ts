import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = pg.Pool;

let pool: pg.Pool | undefined;

/** Shared pool. DATABASE_URL e.g. postgres://vaultchain:pw@localhost:5432/vaultchain */
export function getDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new pg.Pool({ connectionString: url, max: 10, ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });
  return pool;
}

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

/** Applies migrations/*.sql in order, once each. */
export async function migrate(db: Db = getDb()) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`migrated ${file}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function getState(db: Db, key: string): Promise<string | undefined> {
  const r = await db.query<{ value: string }>("SELECT value FROM sync_state WHERE key = $1", [key]);
  return r.rows[0]?.value;
}

export async function setState(db: Db, key: string, value: string) {
  await db.query(
    "INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value],
  );
}

export * from "./repo";
