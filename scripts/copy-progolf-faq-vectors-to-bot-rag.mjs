#!/usr/bin/env node
/**
 * Copy Pro Golf FAQ embeddings from Chatwoot/pgvector Neon into a Helio bot_rag table.
 *
 * Source (default): progolf_support.progolf_faq_vectors on CHATWOOT_PGVECTOR_DATABASE_URL
 * Target (default): bot_rag.faq_progolf_{account}_{inbox}_{bot} on BOT_DB_*
 *
 * Usage:
 *   node --env-file=.env scripts/copy-progolf-faq-vectors-to-bot-rag.mjs \
 *     --target bot_rag.faq_progolf_2_1_30 --agent-bot-id 30 --account-id 2 --inbox-id 1
 *
 * If local CHATWOOT_PGVECTOR_DATABASE_URL points at Neon staging (empty), pass the
 * master/production branch URL:
 *   --source-url 'postgres://...@ep-lucky-flower-.../chatwoot_production'
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    out[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return out;
}

function parseArgs(argv) {
  const out = {
    source: process.env.PGVECTOR_SOURCE_TABLE || 'progolf_support.progolf_faq_vectors',
    sourceUrl: process.env.CHATWOOT_PGVECTOR_SOURCE_DATABASE_URL || '',
    target: process.env.RAG_TARGET_TABLE || '',
    agentBotId: Number(process.env.CHATWOOT_AGENT_BOT_ID || 0),
    accountId: Number(process.env.CHATWOOT_ACCOUNT_ID || 2),
    inboxId: Number(process.env.CHATWOOT_INBOX_ID || 1),
    gameId: process.env.CHATWOOT_GAME_ID || 'progolf',
    portalSlug: process.env.CHATWOOT_PORTAL_SLUG || 'progolf',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--source') out.source = argv[++i];
    else if (arg === '--source-url') out.sourceUrl = argv[++i];
    else if (arg === '--target') out.target = argv[++i];
    else if (arg === '--agent-bot-id') out.agentBotId = Number(argv[++i]);
    else if (arg === '--account-id') out.accountId = Number(argv[++i]);
    else if (arg === '--inbox-id') out.inboxId = Number(argv[++i]);
    else if (arg === '--game-id') out.gameId = argv[++i];
    else if (arg === '--portal-slug') out.portalSlug = argv[++i];
  }
  return out;
}

function assertIdent(qualifiedName, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(qualifiedName)) {
    throw new Error(`${label} must be schema.table (got ${qualifiedName})`);
  }
}

function sslOption(flag) {
  return String(flag || 'false').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false;
}

function createSourceClient(env, sourceUrl) {
  return new pg.Client({
    connectionString: sourceUrl || env.CHATWOOT_PGVECTOR_DATABASE_URL,
    ssl: sslOption(env.CHATWOOT_PGVECTOR_DB_SSL),
  });
}

function createBotClient(env) {
  return new pg.Client({
    host: env.BOT_DB_HOST,
    port: Number(env.BOT_DB_PORT || 5432),
    database: env.BOT_DB_NAME,
    user: env.BOT_DB_USER,
    password: env.BOT_DB_PASSWORD,
    ssl: sslOption(env.BOT_DB_SSL),
  });
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function mapRow(row, args) {
  const meta = parseMetadata(row.metadata);
  const articleId = Number(meta.articleId ?? meta.article_id ?? 0) || 0;
  const chunkIndex = Number(meta.chunkIndex ?? meta.chunk_index ?? 0) || 0;
  const title = String(meta.title || meta.articleTitle || 'FAQ').slice(0, 500);
  const slug = String(meta.articleSlug || meta.slug || meta.article_slug || `article-${articleId || row.id}`);
  const locale = String(meta.locale || 'en');
  const categoryName = meta.categoryName || meta.category_name || meta.category || null;
  const id = `bot_${args.agentBotId}_article_${articleId || 'x'}_chunk_${chunkIndex}_${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`;

  return {
    id,
    account_id: args.accountId,
    inbox_id: args.inboxId,
    agent_bot_id: args.agentBotId,
    game_id: args.gameId,
    portal_slug: args.portalSlug,
    article_id: articleId,
    chunk_index: chunkIndex,
    title,
    article_slug: slug,
    locale,
    category_name: categoryName,
    content: String(row.text || row.content || ''),
    embedding: row.embedding,
    metadata: {
      ...meta,
      source: meta.source || 'progolf_faq_vectors_import',
      importedFrom: args.source,
      originalId: row.id,
      gameId: args.gameId,
      accountId: args.accountId,
      inboxId: args.inboxId,
      agentBotId: args.agentBotId,
      portalSlug: args.portalSlug,
    },
  };
}

async function ensureTargetTable(client, target) {
  const [schema, table] = target.split('.');
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.${table} (
      id text PRIMARY KEY,
      account_id integer NOT NULL,
      inbox_id integer NOT NULL,
      agent_bot_id integer NOT NULL,
      game_id text NOT NULL,
      portal_slug text,
      article_id integer NOT NULL,
      chunk_index integer NOT NULL,
      title text NOT NULL,
      article_slug text NOT NULL,
      locale text NOT NULL,
      category_name text,
      content text NOT NULL,
      embedding vector(1536) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${table}_agent_article_idx
      ON ${schema}.${table} (agent_bot_id, article_id)
  `);
}

async function main() {
  const fileEnv = parseEnvFile(join(root, '.env'));
  const env = { ...fileEnv, ...process.env };
  const args = parseArgs(process.argv);

  if (!args.target) {
    if (!args.agentBotId) throw new Error('--target or --agent-bot-id is required');
    args.target = `bot_rag.faq_${args.gameId}_${args.accountId}_${args.inboxId}_${args.agentBotId}`;
  }
  if (!Number.isInteger(args.agentBotId) || args.agentBotId <= 0) {
    throw new Error('--agent-bot-id must be a positive integer');
  }

  assertIdent(args.source, '--source');
  assertIdent(args.target, '--target');
  const sourceUrl = args.sourceUrl || env.CHATWOOT_PGVECTOR_DATABASE_URL;
  if (!sourceUrl) {
    throw new Error('CHATWOOT_PGVECTOR_DATABASE_URL or --source-url is required');
  }

  const source = createSourceClient(env, sourceUrl);
  const bot = createBotClient(env);
  await source.connect();
  await bot.connect();

  try {
    const sourceDb = await source.query(
      'SELECT current_database() AS db, inet_server_addr()::text AS addr',
    );
    const countResult = await source.query(`SELECT count(*)::int AS n FROM ${args.source}`);
    const sourceCount = countResult.rows[0].n;
    console.log(
      `Source ${args.source} on ${sourceDb.rows[0].db}: ${sourceCount} rows` +
        (args.sourceUrl ? ' (via --source-url)' : ''),
    );
    console.log(`Target ${args.target} (agent_bot_id=${args.agentBotId})`);

    if (sourceCount === 0) {
      console.error(
        '\nNo rows in source table.\n' +
          'Local CHATWOOT_PGVECTOR_DATABASE_URL often points at Neon staging (empty).\n' +
          'Use --source-url with the master/production branch connection string ' +
          '(mindstorm-chatwoot / br-aged-poetry has the real progolf_faq_vectors).',
      );
      process.exitCode = 2;
      return;
    }

    if (args.dryRun) {
      const sample = await source.query(`SELECT id, LEFT(COALESCE(text, ''), 80) AS preview FROM ${args.source} LIMIT 3`);
      console.log('Dry run sample:', sample.rows);
      return;
    }

    await ensureTargetTable(bot, args.target);

    const rows = await source.query(`SELECT id, text, metadata, embedding FROM ${args.source}`);
    let upserted = 0;
    for (const row of rows.rows) {
      const mapped = mapRow(row, args);
      if (!mapped.content || !mapped.embedding) continue;
      await bot.query(
        `INSERT INTO ${args.target} (
           id, account_id, inbox_id, agent_bot_id, game_id, portal_slug,
           article_id, chunk_index, title, article_slug, locale, category_name,
           content, embedding, metadata, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector,$15::jsonb, now()
         )
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata,
           title = EXCLUDED.title,
           category_name = EXCLUDED.category_name,
           updated_at = now()`,
        [
          mapped.id,
          mapped.account_id,
          mapped.inbox_id,
          mapped.agent_bot_id,
          mapped.game_id,
          mapped.portal_slug,
          mapped.article_id,
          mapped.chunk_index,
          mapped.title,
          mapped.article_slug,
          mapped.locale,
          mapped.category_name,
          mapped.content,
          mapped.embedding,
          JSON.stringify(mapped.metadata),
        ],
      );
      upserted += 1;
    }

    const targetCount = await bot.query(`SELECT count(*)::int AS n FROM ${args.target}`);
    console.log(`Upserted ${upserted} rows. Target now has ${targetCount.rows[0].n} rows.`);
  } finally {
    await source.end();
    await bot.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
