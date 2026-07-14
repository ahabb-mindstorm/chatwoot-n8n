#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));

const ACCOUNT_ID = Number(env.CHATWOOT_ACCOUNT_ID || 2);
const BOT_ID = 1;
const BOT_TOKEN = env.CHATWOOT_AGENT_BOT_ACCESS_TOKEN;
const HELIO_BASE = env.CHATWOOT_BASE_URL || 'http://localhost:3000';
const N8N_BASE = env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_KEY = env.N8N_API_KEY;
const CSR_DB =
  'postgresql://neondb_owner:npg_g5uRXYnWHN9m@ep-round-bread-ad15olhn-pooler.c-2.us-east-1.aws.neon.tech/mindstorm_csr?sslmode=require';
const WIDGET_ID = process.argv[2] || 'M8aqWvyOKTrB4VUteK6nbKa9';
const MAIN_WORKFLOW_ID = process.argv[3];

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
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`n8n ${path} -> ${response.status}: ${text}`);
  return body;
}

function verifyWorkflowStructure(workflow) {
  const serialized = JSON.stringify(workflow);
  const tool = workflow.nodes.find((n) => n.name === 'Get Escalation Requirements');
  const load = workflow.nodes.find((n) => n.name === 'Load Canonical Escalation Requirements');
  return [
    ['no sub-workflow id', !/YD4d0AAkcvOSSLua/.test(serialized)],
    ['no toolWorkflow', !/toolWorkflow/.test(serialized)],
    ['no executeWorkflow escalation loader', load?.type !== 'n8n-nodes-base.executeWorkflow'],
    ['tool is toolCode', tool?.type === '@n8n/n8n-nodes-langchain.toolCode'],
    ['tool uses resolveEscalation', /resolveEscalation/.test(tool?.parameters?.jsCode || '')],
    ['load is code node', load?.type === 'n8n-nodes-base.code'],
    ['load uses resolveEscalation', /resolveEscalation/.test(load?.parameters?.jsCode || '')],
    ['load bot config present', workflow.nodes.some((n) => n.name === 'Load Bot Config')],
    ['workflow active', workflow.active === true],
  ];
}

async function waitForBotReply(conversationId, afterMessageId, timeoutMs = 45000) {
  const client = new pg.Client({ connectionString: CSR_DB });
  await client.connect();
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await client.query(
        `SELECT id, message_type, LEFT(content, 240) AS content
         FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id`,
        [conversationId, afterMessageId],
      );
      if (result.rows.some((row) => row.message_type === 1)) return result.rows;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const final = await client.query(
      `SELECT id, message_type, LEFT(content, 240) AS content
       FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    );
    return final.rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const db = new pg.Client({ connectionString: CSR_DB });
  await db.connect();
  const bot = await db.query('SELECT outgoing_url, provisioning, config_version, bot_config FROM agent_bots WHERE id=$1', [BOT_ID]);
  await db.end();
  const mainId = MAIN_WORKFLOW_ID || bot.rows[0]?.provisioning?.response?.mainWorkflowId;
  console.log('bot outgoing_url', bot.rows[0]?.outgoing_url);
  console.log('config_version', bot.rows[0]?.config_version);
  console.log('mainWorkflowId', mainId);

  console.log('\n=== Workflow structure ===');
  const workflow = await n8nRequest(`/api/v1/workflows/${mainId}`);
  for (const [label, ok] of verifyWorkflowStructure(workflow)) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok) process.exitCode = 1;
  }

  console.log('\n=== Helio config API ===');
  const configResponse = await fetch(
    `${HELIO_BASE}/api/v1/accounts/${ACCOUNT_ID}/agent-bots/${BOT_ID}/config`,
    { headers: { 'api-access-token': BOT_TOKEN } },
  );
  const configBody = await configResponse.json();
  const keys = Object.keys(configBody.botRuntimeConfig?.escalationRequirements || {});
  console.log(`${configResponse.ok ? 'PASS' : 'FAIL'} config API status ${configResponse.status}`);
  console.log(`${keys.includes('withdrawal') ? 'PASS' : 'FAIL'} withdrawal template (${keys.length} keys)`);

  console.log('\n=== Webhook reachability ===');
  const hook = await fetch(bot.rows[0].outgoing_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'ping' }),
  });
  console.log(`${hook.status === 200 || hook.status === 204 ? 'PASS' : 'WARN'} webhook POST status ${hook.status}`);

  console.log('\n=== Widget chat ===');
  const api = `${HELIO_BASE}/public/api/v1/inboxes/${WIDGET_ID}`;
  const sourceId = `verify-${Date.now()}`;
  await fetch(`${api}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, name: 'Verify Bot' }),
  });
  const conv = await (await fetch(`${api}/contacts/${sourceId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  const hello = await (await fetch(`${api}/contacts/${sourceId}/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello verify bot' }),
  })).json();
  console.log('conversation', conv.id);
  const helloMsgs = await waitForBotReply(conv.id, hello.id);
  console.log('hello replies', JSON.stringify(helloMsgs, null, 2));
  const gotHelloReply = helloMsgs.some((m) => m.message_type === 1);
  console.log(`${gotHelloReply ? 'PASS' : 'FAIL'} bot replied to hello`);

  console.log('\n=== Escalation withdrawal ===');
  const withdrawal = await (await fetch(`${api}/contacts/${sourceId}/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content:
        'My PayPal withdrawal of $25 on 2026-06-10 never arrived. Transaction ID TX-VERIFY-1. PayPal you@example.com.',
    }),
  })).json();
  const escMsgs = await waitForBotReply(conv.id, withdrawal.id, 60000);
  console.log('escalation replies', JSON.stringify(escMsgs, null, 2));
  const lastBot = [...escMsgs].reverse().find((m) => m.message_type === 1);
  const escalationAware = lastBot && /detail|paypal|transaction|investigate|support team|withdrawal/i.test(lastBot.content);
  console.log(`${escalationAware ? 'PASS' : 'FAIL'} escalation-aware reply`);

  console.log('\n=== n8n latest execution ===');
  const executions = await n8nRequest('/api/v1/executions?limit=5&workflowId=' + encodeURIComponent(mainId));
  const latest = executions.data?.[0];
  if (latest) {
    console.log('latest execution', latest.id, latest.status, latest.stoppedAt || latest.startedAt);
    const detail = await n8nRequest(`/api/v1/executions/${latest.id}?includeData=true`);
    const runData = detail.data?.resultData?.runData || {};
    const loadNode = runData['Load Canonical Escalation Requirements'];
    const toolHits = runData['Get Escalation Requirements'];
    if (loadNode) {
      const sample = loadNode[0]?.data?.main?.[0]?.[0]?.json;
      console.log('Load Canonical sample', JSON.stringify(sample, null, 2));
      console.log(`${sample?.source === 'bot_config' ? 'PASS' : 'FAIL'} resolver source=${sample?.source}`);
      console.log(`${(sample?.required_fields || []).includes('paypal_email') ? 'PASS' : 'FAIL'} withdrawal required_fields`);
    } else {
      console.log('WARN Load Canonical node not in latest execution (may still be debouncing)');
    }
    if (toolHits) console.log('PASS agent tool node executed');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
