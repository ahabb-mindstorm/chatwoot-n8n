import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationFiles = [
  '001_bot_support_state.sql',
  '003_support_state.sql',
  '006_idempotency_debounce.sql',
  '007_agent_bot_kill_switch.sql',
  '009_agent_bot_scoped_recovery.sql',
  '010_agent_bot_scoped_claim.sql',
  '011_agent_bot_scoped_ticket_state.sql',
  '012_unscoped_recover_legacy_only.sql',
  '013_support_runtime_turns.sql',
];
const migrations = migrationFiles.map((file) => ({
  file,
  sql: readFileSync(join(root, 'migrations', file), 'utf8'),
}));
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
  for (const migration of migrations) {
    await client.query(migration.sql);
  }
  await client.query('COMMIT');
  const result = await client.query(`
    SELECT
      to_regclass('public.bot_support_turns') IS NOT NULL AS support_turns,
      to_regprocedure('public.bot_commit_support_turn(bigint,bigint,bigint,text,integer,text,jsonb,jsonb,text,integer,text)') IS NOT NULL AS commit_function
  `);
  console.log(JSON.stringify({
    ...result.rows[0],
    migrations: migrationFiles,
  }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
