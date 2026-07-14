#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildProgolfBotConfig } from '../workflows/progolf-escalation-template.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));

const ACCOUNT_ID = Number(env.CHATWOOT_ACCOUNT_ID || 2);
const INBOX_ID = Number(env.CHATWOOT_INBOX_ID || 1);
const BOT_ID = 1;
const BOT_TOKEN = env.CHATWOOT_AGENT_BOT_ACCESS_TOKEN;
const WEBHOOK_SECRET = env.CHATWOOT_WEBHOOK_SECRET;
const HELIO_BASE = env.CHATWOOT_BASE_URL || 'http://localhost:3000';
const FACTORY_URL = env.BOT_FACTORY_URL || 'http://localhost:3020/provision-bot';
const FACTORY_SECRET = env.BOT_FACTORY_API_SECRET;
const N8N_BASE = env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_KEY = env.N8N_API_KEY;
const CSR_DB =
  env.HELIO_DATABASE_URL ||
  'postgresql://neondb_owner:npg_g5uRXYnWHN9m@ep-round-bread-ad15olhn-pooler.c-2.us-east-1.aws.neon.tech/mindstorm_csr?sslmode=require';

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

async function n8nRequest(path, options = {}) {
  const response = await fetch(`${N8N_BASE}${path}`, {
    ...options,
    headers: {
      'X-N8N-API-KEY': N8N_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`n8n ${options.method || 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

async function deactivateHelioWorkflows() {
  const list = await n8nRequest('/api/v1/workflows?limit=250');
  const helio = (list.data || []).filter((wf) => /helio/i.test(wf.name || ''));
  for (const wf of helio) {
    if (wf.active) {
      await n8nRequest(`/api/v1/workflows/${wf.id}/deactivate`, { method: 'POST' });
      console.log(`deactivated ${wf.id} ${wf.name}`);
    }
  }
  return helio.map((wf) => wf.id);
}

function verifyWorkflowStructure(workflow) {
  const serialized = JSON.stringify(workflow);
  const tool = workflow.nodes.find((n) => n.name === 'Get Escalation Requirements');
  const load = workflow.nodes.find((n) => n.name === 'Load Canonical Escalation Requirements');
  const checks = [];
  checks.push(['no sub-workflow id', !/YD4d0AAkcvOSSLua/.test(serialized)]);
  checks.push(['no toolWorkflow', !/toolWorkflow/.test(serialized)]);
  checks.push(['tool is toolCode', tool?.type === '@n8n/n8n-nodes-langchain.toolCode']);
  checks.push(['tool uses resolveEscalation', /resolveEscalation/.test(tool?.parameters?.jsCode || '')]);
  checks.push(['load is code node', load?.type === 'n8n-nodes-base.code']);
  checks.push(['load uses resolveEscalation', /resolveEscalation/.test(load?.parameters?.jsCode || '')]);
  checks.push(['load bot config present', workflow.nodes.some((n) => n.name === 'Load Bot Config')]);
  return checks;
}

async function waitForBotReply(conversationId, afterMessageId, timeoutMs = 45000) {
  const client = new pg.Client({ connectionString: CSR_DB });
  await client.connect();
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await client.query(
        `SELECT id, message_type, LEFT(content, 200) AS content
         FROM messages
         WHERE conversation_id = $1 AND id > $2
         ORDER BY id`,
        [conversationId, afterMessageId],
      );
      const outgoing = result.rows.filter((row) => row.message_type === 1);
      if (outgoing.length > 0) return result.rows;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const final = await client.query(
      `SELECT id, message_type, LEFT(content, 200) AS content
       FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    );
    return final.rows;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('=== 1. Seed bot_config.escalationRequirements in Helio ===');
  const progolfBotConfig = buildProgolfBotConfig();
  const client = new pg.Client({ connectionString: CSR_DB });
  await client.connect();
  const before = await client.query('SELECT bot_config, config_version FROM agent_bots WHERE id = $1', [BOT_ID]);
  const nextConfig = {
    ...(before.rows[0]?.bot_config || {}),
    gameId: 'progolf',
    portalSlug: 'progolf-help',
    ...progolfBotConfig,
  };
  await client.query(
    `UPDATE agent_bots
     SET bot_config = $1::jsonb, config_version = config_version + 1
     WHERE id = $2`,
    [JSON.stringify(nextConfig), BOT_ID],
  );
  const seeded = await client.query('SELECT config_version, bot_config FROM agent_bots WHERE id = $1', [BOT_ID]);
  console.log('config_version', seeded.rows[0].config_version);
  console.log('escalation keys', Object.keys(seeded.rows[0].bot_config.escalationRequirements || {}));
  await client.end();

  console.log('\n=== 2. Deactivate existing Helio workflows in n8n ===');
  const deactivated = await deactivateHelioWorkflows();
  console.log('deactivated count', deactivated.length);

  console.log('\n=== 3. Factory provision ===');
  const payload = {
    accountId: ACCOUNT_ID,
    inboxId: INBOX_ID,
    gameId: 'progolf',
    portalSlug: 'progolf-help',
    name: 'n8n-progolf-support',
    systemMessage: null,
    botConfig: nextConfig,
    helioBaseUrl: HELIO_BASE,
    bot: {
      id: BOT_ID,
      accessToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      configUrl: `/api/v1/accounts/${ACCOUNT_ID}/agent-bots/${BOT_ID}/config`,
    },
  };
  const factoryResponse = await fetch(FACTORY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FACTORY_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  const factoryBody = await factoryResponse.json();
  if (!factoryResponse.ok) {
    throw new Error(`Factory provision failed: ${factoryResponse.status} ${JSON.stringify(factoryBody)}`);
  }
  console.log(JSON.stringify(factoryBody, null, 2));

  console.log('\n=== 4. Update Helio agent_bots provisioning metadata ===');
  const db = new pg.Client({ connectionString: CSR_DB });
  await db.connect();
  await db.query(
    `UPDATE agent_bots
     SET outgoing_url = $1,
         provisioning = provisioning || $2::jsonb
     WHERE id = $3`,
    [
      factoryBody.webhookUrl,
      JSON.stringify({
        status: 'active',
        provisionedAt: new Date().toISOString(),
        response: factoryBody,
      }),
      BOT_ID,
    ],
  );
  const botRow = await db.query('SELECT outgoing_url, provisioning FROM agent_bots WHERE id = $1', [BOT_ID]);
  console.log('outgoing_url', botRow.rows[0].outgoing_url);
  const inbox = await db.query(
    `SELECT ca.identifier
     FROM inboxes i
     JOIN channel_api ca ON ca.id = i.channel_id
     WHERE i.id = $1`,
    [INBOX_ID],
  );
  const widgetId = inbox.rows[0]?.identifier;
  await db.end();

  console.log('\n=== 5. Verify deployed workflow structure ===');
  const workflow = await n8nRequest(`/api/v1/workflows/${factoryBody.mainWorkflowId}`);
  const checks = verifyWorkflowStructure(workflow);
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok) process.exitCode = 1;
  }

  console.log('\n=== 6. Verify Helio config API returns escalationRequirements ===');
  const configResponse = await fetch(
    `${HELIO_BASE}/api/v1/accounts/${ACCOUNT_ID}/agent-bots/${BOT_ID}/config`,
    { headers: { 'api-access-token': BOT_TOKEN } },
  );
  const configBody = await configResponse.json();
  if (!configResponse.ok) throw new Error(`config API failed: ${configResponse.status}`);
  const reqKeys = Object.keys(configBody.botRuntimeConfig?.escalationRequirements || {});
  console.log('config API keys', reqKeys.length, reqKeys.slice(0, 5).join(', '), '...');
  console.log(`${reqKeys.includes('withdrawal') ? 'PASS' : 'FAIL'} withdrawal template in config API`);

  console.log('\n=== 7. Widget chat smoke test ===');
  const api = `${HELIO_BASE}/public/api/v1/inboxes/${widgetId}`;
  const sourceId = `reprov-${Date.now()}`;
  await fetch(`${api}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, name: 'Reprovision Test' }),
  });
  const convRes = await fetch(`${api}/contacts/${sourceId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const conv = await convRes.json();
  const conversationId = conv.id;
  const msgRes = await fetch(`${api}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello after reprovision' }),
  });
  const sentMsg = await msgRes.json();
  console.log('conversation', conversationId, 'sent message', sentMsg.id);
  const messages = await waitForBotReply(conversationId, sentMsg.id);
  console.log('messages after hello:', JSON.stringify(messages, null, 2));

  console.log('\n=== 8. Escalation path test (withdrawal) ===');
  const escRes = await fetch(`${api}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content:
        'My PayPal withdrawal of $25 on 2026-06-10 never arrived. Transaction ID TX-12345. PayPal is you@example.com.',
    }),
  });
  const escMsg = await escRes.json();
  const escMessages = await waitForBotReply(conversationId, escMsg.id, 60000);
  console.log('messages after withdrawal:', JSON.stringify(escMessages, null, 2));

  const lastBot = [...escMessages].reverse().find((m) => m.message_type === 1);
  if (lastBot?.content) {
    const asksForDetails = /detail|paypal|transaction|investigate|support team/i.test(lastBot.content);
    console.log(`${asksForDetails ? 'PASS' : 'WARN'} bot reply looks escalation-aware: ${lastBot.content}`);
  }

  console.log('\n=== Done ===');
  console.log('webhook', factoryBody.webhookUrl);
  console.log('mainWorkflowId', factoryBody.mainWorkflowId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
