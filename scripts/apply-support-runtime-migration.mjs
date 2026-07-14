import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(
  join(root, 'migrations', '013_support_runtime_turns.sql'),
  'utf8',
);
const sslEnabled = /^(1|true|yes)$/i.test(
  String(process.env.BOT_DB_SSL || ''),
);
const client = new pg.Client({
  connectionString: process.env.BOT_DATABASE_URL || undefined,
  host: process.env.BOT_DATABASE_URL
    ? undefined
    : process.env.BOT_DB_HOST || 'postgres',
  port: process.env.BOT_DATABASE_URL
    ? undefined
    : Number(process.env.BOT_DB_PORT || 5432),
  database: process.env.BOT_DATABASE_URL
    ? undefined
    : process.env.BOT_DB_NAME || process.env.POSTGRES_DB || 'chatwoot_bot',
  user: process.env.BOT_DATABASE_URL
    ? undefined
    : process.env.BOT_DB_USER || process.env.POSTGRES_USER || 'chatwoot_bot',
  password: process.env.BOT_DATABASE_URL
    ? undefined
    : process.env.BOT_DB_PASSWORD || process.env.POSTGRES_PASSWORD,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  const result = await client.query(`
    SELECT
      to_regclass('public.bot_support_turns') IS NOT NULL AS support_turns,
      to_regprocedure('public.bot_commit_support_turn(bigint,bigint,bigint,text,integer,text,jsonb,jsonb,text,integer,text)') IS NOT NULL AS commit_function
  `);
  console.log(JSON.stringify(result.rows[0]));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
