#!/usr/bin/env node
/**
 * Import Helpshift HC-SDKX FAQ sections into a Helio bot_rag.* table.
 *
 * Discovers section publish ids from the app landing page, fetches each section
 * via /xhr/support/section/{id}/ (requires X-Requested-With), embeds chunks,
 * and upserts into bot_rag.faq_{game}_{account}_{inbox}_{bot}.
 *
 * Usage:
 *   node --env-file=.env scripts/import-helpshift-xhr-to-bot-rag.mjs \
 *     --platform-id algames_platform_20240129201332045-7e197bedd0b9c2c \
 *     --target bot_rag.faq_hexasort_13_13_33 \
 *     --agent-bot-id 33 --account-id 13 --inbox-id 13 --game-id hexasort \
 *     --recreate
 *
 * Options:
 *   --dry-run       Fetch + chunk only; no OpenAI or Postgres writes
 *   --recreate      Delete all rows for this agent_bot_id before upsert
 *   --section-ids   Comma-separated section publish ids (skip discovery)
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { htmlToText, slugify } from './lib/helpshift-chunks.mjs';
import {
  DEFAULT_EMBEDDING_MODEL,
  embedTexts,
  vectorLiteral,
} from './lib/pgvector-ingest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOMAIN = 'algames';
const CHUNK_MAX = 1200;
const CHUNK_OVERLAP = 180;

function parseArgs(argv) {
  const out = {
    domain: process.env.HELPSHIFT_DOMAIN || DEFAULT_DOMAIN,
    platformId: process.env.HELPSHIFT_PLATFORM_ID || '',
    appId: process.env.HELPSHIFT_APP_ID || '',
    platformType: process.env.HELPSHIFT_PLATFORM_TYPE || 'ios',
    lang: process.env.HELPSHIFT_LANG || 'en',
    target: process.env.RAG_TARGET_TABLE || '',
    agentBotId: Number(process.env.CHATWOOT_AGENT_BOT_ID || 0),
    accountId: Number(process.env.CHATWOOT_ACCOUNT_ID || 0),
    inboxId: Number(process.env.CHATWOOT_INBOX_ID || 0),
    gameId: process.env.CHATWOOT_GAME_ID || '',
    portalSlug: process.env.CHATWOOT_PORTAL_SLUG || 'helpshift',
    sectionIds: [],
    recreate: false,
    dryRun: false,
    dumpJson: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--recreate') out.recreate = true;
    else if (arg === '--domain') out.domain = argv[++i];
    else if (arg === '--platform-id') out.platformId = argv[++i];
    else if (arg === '--app-id') out.appId = argv[++i];
    else if (arg === '--platform-type') out.platformType = argv[++i];
    else if (arg === '--lang') out.lang = argv[++i];
    else if (arg === '--target') out.target = argv[++i];
    else if (arg === '--agent-bot-id') out.agentBotId = Number(argv[++i]);
    else if (arg === '--account-id') out.accountId = Number(argv[++i]);
    else if (arg === '--inbox-id') out.inboxId = Number(argv[++i]);
    else if (arg === '--game-id') out.gameId = argv[++i];
    else if (arg === '--portal-slug') out.portalSlug = argv[++i];
    else if (arg === '--section-ids') {
      out.sectionIds = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--dump-json') out.dumpJson = argv[++i];
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

function createBotClient() {
  return new pg.Client({
    host: process.env.BOT_DB_HOST,
    port: Number(process.env.BOT_DB_PORT || 5432),
    database: process.env.BOT_DB_NAME,
    user: process.env.BOT_DB_USER,
    password: process.env.BOT_DB_PASSWORD,
    ssl: sslOption(process.env.BOT_DB_SSL),
  });
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'helio-helpshift-importer/1.0',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status})`);
  }
  return res.json();
}

function landingUrl(args) {
  return `https://${args.domain}.helpshift.com/hc-sdkx/${args.lang}/app/${args.platformId}/`;
}

function sectionUrl(args, sectionPublishId) {
  const params = new URLSearchParams({
    lang: args.lang,
    is_sdkx: 'true',
    app_id: args.appId,
    platform_type: args.platformType,
    hc_mode: 'sdkx',
    platform_id: args.platformId,
  });
  return `https://${args.domain}.helpshift.com/xhr/support/section/${sectionPublishId}/?${params}`;
}

function extractInlineSectionsPayload(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const body = String(match[1] || '').trim();
    if (!body.startsWith('{') || !body.includes('"sections"')) continue;
    try {
      return JSON.parse(body);
    } catch {
      // keep looking
    }
  }
  throw new Error('Could not find embedded sections JSON on Helpshift landing page');
}

function collectSectionPublishIds(landing, html) {
  const pubs = new Set();
  for (const id of html.matchAll(/\/section\/(\d+)\//g)) pubs.add(id[1]);
  for (const article of landing.popular_articles || []) {
    const publishId = article?.section?.publish_id;
    if (publishId) pubs.add(String(publishId));
    const url = article?.section?.url || '';
    const m = url.match(/\/section\/(\d+)\//);
    if (m) pubs.add(m[1]);
  }
  return [...pubs].sort((a, b) => Number(a) - Number(b));
}

function faqPublishIdFromUrl(url) {
  const m = String(url || '').match(/\/faq\/(\d+)\//);
  return m ? Number(m[1]) : null;
}

function chunkFaqText(title, bodyText) {
  const text = `${title}\n\n${bodyText}`.trim();
  if (!text) return [];
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_MAX - CHUNK_OVERLAP) {
    const chunk = text.slice(start, start + CHUNK_MAX).trim();
    if (chunk) chunks.push(chunk);
    if (start + CHUNK_MAX >= text.length) break;
  }
  return chunks;
}

async function loadHelpshiftFaqs(args) {
  const landingHtml = await (await fetch(landingUrl(args), {
    headers: { 'User-Agent': 'helio-helpshift-importer/1.0' },
  })).text();
  const landing = extractInlineSectionsPayload(landingHtml);
  if (!args.appId) args.appId = String(landing.app_id || '').trim();
  if (!args.appId) throw new Error('--app-id is required (not found on landing page)');

  const sectionIds =
    args.sectionIds.length > 0
      ? args.sectionIds
      : collectSectionPublishIds(landing, landingHtml);
  if (sectionIds.length === 0) {
    throw new Error('No Helpshift section publish ids discovered');
  }

  const byId = new Map();
  const sections = [];
  for (const sectionPublishId of sectionIds) {
    let payload;
    try {
      const json = await fetchJson(sectionUrl(args, sectionPublishId));
      payload = json?.data || json;
    } catch (error) {
      console.warn(`skip section ${sectionPublishId}: ${error.message}`);
      continue;
    }
    const title = String(payload?.title || '').trim();
    const faqs = Array.isArray(payload?.faqs) ? payload.faqs : [];
    sections.push({
      publish_id: sectionPublishId,
      id: payload?.id || '',
      title,
      faq_count: faqs.length,
    });
    console.log(`section ${sectionPublishId}: ${title} -> ${faqs.length} faqs`);
    for (const faq of faqs) {
      const id = String(faq?.id || '').trim();
      if (!id) continue;
      const publishId = faqPublishIdFromUrl(faq.url);
      byId.set(id, {
        id,
        title: String(faq.title || '').trim(),
        body: String(faq.body || ''),
        url: String(faq.url || ''),
        sectionTitle: title,
        sectionId: String(payload?.id || ''),
        sectionPublishId: String(sectionPublishId),
        faqPublishId: publishId,
      });
    }
  }

  // Landing popular / section previews can include FAQs missing from section XHR misses.
  for (const article of landing.popular_articles || []) {
    const id = String(article?.id || '').trim();
    if (!id || byId.has(id)) continue;
    const section = article.section || {};
    byId.set(id, {
      id,
      title: String(article.title || '').trim(),
      body: String(article.body || ''),
      url: String(article.url || ''),
      sectionTitle: String(section.title || ''),
      sectionId: String(section.id || ''),
      sectionPublishId: String(section.publish_id || ''),
      faqPublishId: faqPublishIdFromUrl(article.url),
    });
  }

  return { landing, sections, faqs: [...byId.values()] };
}

function buildRows(faqs, args) {
  const rows = [];
  for (const faq of faqs) {
    const articleId = Number(faq.faqPublishId);
    if (!Number.isInteger(articleId) || articleId <= 0) {
      console.warn(`skip FAQ without numeric publish id: ${faq.id} (${faq.title})`);
      continue;
    }
    const bodyText = htmlToText(faq.body);
    if (!bodyText) {
      console.warn(`skip empty FAQ body: ${faq.id} (${faq.title})`);
      continue;
    }
    const chunks = chunkFaqText(faq.title, bodyText);
    const articleSlug = `${slugify(faq.title) || 'faq'}-${articleId}`;
    chunks.forEach((content, chunkIndex) => {
      const id = `bot_${args.agentBotId}_article_${articleId}_chunk_${chunkIndex}`;
      rows.push({
        id,
        account_id: args.accountId,
        inbox_id: args.inboxId,
        agent_bot_id: args.agentBotId,
        game_id: args.gameId,
        portal_slug: args.portalSlug,
        article_id: articleId,
        chunk_index: chunkIndex,
        title: faq.title.slice(0, 500),
        article_slug: articleSlug.slice(0, 500),
        locale: args.lang,
        category_name: faq.sectionTitle || null,
        content,
        metadata: {
          source: 'helpshift_xhr',
          doc_id: id,
          gameId: args.gameId,
          accountId: args.accountId,
          inboxId: args.inboxId,
          agentBotId: args.agentBotId,
          portalSlug: args.portalSlug,
          articleId,
          articleSlug,
          title: faq.title,
          locale: args.lang,
          categoryName: faq.sectionTitle || '',
          helpshiftFaqId: faq.id,
          helpshiftSectionId: faq.sectionId,
          helpshiftSectionPublishId: faq.sectionPublishId,
          helpshiftUrl: faq.url,
        },
      });
    });
  }
  return rows;
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
}

async function upsertRows(client, target, rows, embeddings) {
  const [schema, table] = target.split('.');
  const sql = `
    INSERT INTO ${schema}.${table} (
      id, account_id, inbox_id, agent_bot_id, game_id, portal_slug,
      article_id, chunk_index, title, article_slug, locale, category_name,
      content, embedding, metadata, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector,$15::jsonb, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      article_slug = EXCLUDED.article_slug,
      locale = EXCLUDED.locale,
      category_name = EXCLUDED.category_name,
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await client.query(sql, [
      row.id,
      row.account_id,
      row.inbox_id,
      row.agent_bot_id,
      row.game_id,
      row.portal_slug,
      row.article_id,
      row.chunk_index,
      row.title,
      row.article_slug,
      row.locale,
      row.category_name,
      row.content,
      vectorLiteral(embeddings[i]),
      JSON.stringify(row.metadata),
    ]);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.platformId) throw new Error('--platform-id is required');
  if (!Number.isInteger(args.agentBotId) || args.agentBotId <= 0) {
    throw new Error('--agent-bot-id must be a positive integer');
  }
  if (!Number.isInteger(args.accountId) || args.accountId <= 0) {
    throw new Error('--account-id must be a positive integer');
  }
  if (!Number.isInteger(args.inboxId) || args.inboxId <= 0) {
    throw new Error('--inbox-id must be a positive integer');
  }
  if (!args.gameId) throw new Error('--game-id is required');
  if (!args.target) {
    args.target = `bot_rag.faq_${args.gameId}_${args.accountId}_${args.inboxId}_${args.agentBotId}`;
  }
  assertIdent(args.target, '--target');

  console.log(`Landing: ${landingUrl(args)}`);
  const { sections, faqs } = await loadHelpshiftFaqs(args);
  const rows = buildRows(faqs, args);
  console.log(`Sections fetched: ${sections.length}`);
  console.log(`FAQs:             ${faqs.length}`);
  console.log(`Chunks:           ${rows.length}`);
  console.log(`Target:           ${args.target}`);

  if (args.dumpJson) {
    await writeFile(
      args.dumpJson,
      JSON.stringify({ sections, faqs, chunkCount: rows.length }, null, 2),
    );
    console.log(`Wrote dump: ${args.dumpJson}`);
  }

  if (args.dryRun) {
    console.log('\nDry run — no OpenAI or Postgres writes.');
    const freeze = faqs.find((f) => /freez|crash|not loading/i.test(f.title));
    if (freeze) {
      console.log(`Freeze FAQ present: ${freeze.title} (publish ${freeze.faqPublishId})`);
    }
    return;
  }

  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  console.log(`\nEmbedding ${rows.length} chunks with ${embeddingModel}...`);
  const embeddings = await embedTexts(
    rows.map((row) => row.content),
    { model: embeddingModel },
  );

  const client = createBotClient();
  await client.connect();
  try {
    await ensureTargetTable(client, args.target);
    const [schema, table] = args.target.split('.');
    if (args.recreate) {
      const deleted = await client.query(
        `DELETE FROM ${schema}.${table} WHERE agent_bot_id = $1`,
        [args.agentBotId],
      );
      console.log(`Deleted ${deleted.rowCount} existing rows for agent_bot_id=${args.agentBotId}`);
    }
    await upsertRows(client, args.target, rows, embeddings);
    const total = await client.query(`SELECT COUNT(*)::int AS n FROM ${schema}.${table}`);
    console.log('\nDone.');
    console.log(`  Upserted: ${rows.length}`);
    console.log(`  Total:    ${total.rows[0].n}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
