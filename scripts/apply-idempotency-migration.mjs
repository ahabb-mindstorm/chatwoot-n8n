import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(root, "migrations/006_idempotency_debounce.sql"), "utf8");
const sslEnabled = String(process.env.BOT_DB_SSL || "false").toLowerCase() === "true";
const client = new pg.Client({
  host: process.env.BOT_DB_HOST || "postgres",
  port: Number(process.env.BOT_DB_PORT || 5432),
  database: process.env.BOT_DB_NAME || process.env.POSTGRES_DB || "chatwoot_bot",
  user: process.env.BOT_DB_USER || process.env.POSTGRES_USER || "chatwoot_bot",
  password: process.env.BOT_DB_PASSWORD || process.env.POSTGRES_PASSWORD,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  const result = await client.query(`
    SELECT
      to_regclass('public.bot_inbound_events') IS NOT NULL AS inbound_events,
      to_regclass('public.bot_conversation_leases') IS NOT NULL AS conversation_leases,
      to_regclass('public.bot_outbound_effects') IS NOT NULL AS outbound_effects
  `);
  console.log(JSON.stringify(result.rows[0]));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

