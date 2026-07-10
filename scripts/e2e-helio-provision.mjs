#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const helioRoot = join(root, '..', 'Helio', 'MindstormCustomerService-BE');

const n8nEnv = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
const helioEnv = parseEnv(readFileSync(join(helioRoot, '.env'), 'utf8'));

const HELIO_API = process.env.HELIO_API_BASE || 'http://localhost:3000/api/v1';
const FACTORY_BASE = process.env.BOT_FACTORY_BASE || 'http://localhost:3020';
const ACCOUNT_ID = Number(process.env.CHATWOOT_ACCOUNT_ID || n8nEnv.CHATWOOT_ACCOUNT_ID || 2);
const INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID || n8nEnv.CHATWOOT_INBOX_ID || 1);
const N8N_BASE = n8nEnv.N8N_BASE_URL || 'http://localhost:5678';
const N8N_KEY = n8nEnv.N8N_API_KEY;
const FACTORY_SECRET = n8nEnv.BOT_FACTORY_API_SECRET || helioEnv.BOT_FACTORY_API_SECRET;
const CSR_DB = helioEnv.DATABASE_URL;
const WIDGET_ID = process.env.WIDGET_ID || 'M8aqWvyOKTrB4VUteK6nbKa9';

const results = [];
let exitCode = 0;

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

function record(name, ok, detail = '', { critical = true } = {}) {
  results.push({ name, ok, detail, critical });
  console.log(`${ok ? 'PASS' : critical ? 'FAIL' : 'WARN'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && critical) exitCode = 1;
}

async function ensureClerkUserLinked(email = process.env.E2E_CLERK_EMAIL || 'admin@mindstormstudios.com') {
  const snippet = `
import { createClerkClient } from '@clerk/backend';
import pg from 'pg';
const email = ${JSON.stringify(email)};
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const users = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
if (!users.data.length) throw new Error('Clerk user not found for ' + email);
const clerkUserId = users.data[0].id;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const existing = await client.query('SELECT id, clerk_user_id FROM users WHERE email = $1 LIMIT 1', [email]);
if (!existing.rows.length) throw new Error('Helio user not found for ' + email);
if (existing.rows[0].clerk_user_id !== clerkUserId) {
  await client.query('UPDATE users SET clerk_user_id = $1 WHERE id = $2', [clerkUserId, existing.rows[0].id]);
}
await client.end();
const session = await clerk.sessions.createSession({ userId: clerkUserId });
const token = await clerk.sessions.getToken(session.id);
const jwt = typeof token === 'string' ? token : token.jwt;
if (!jwt) throw new Error('Clerk session token missing');
process.stdout.write(jwt);
`;
  const { stdout } = await execFileAsync(
    'node',
    ['--env-file=.env', '--input-type=module', '-e', snippet],
    { cwd: helioRoot, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

let helioAuthToken = null;

async function refreshHelioAuthToken() {
  helioAuthToken = await ensureClerkUserLinked();
  return helioAuthToken;
}

async function helioRequest(path, { method = 'GET', body, refreshToken = false } = {}) {
  if (!helioAuthToken || refreshToken) {
    await refreshHelioAuthToken();
  }
  const response = await fetch(`${HELIO_API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${helioAuthToken}`,
      'x-workspace-account-id': String(ACCOUNT_ID),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (response.status === 401 && !refreshToken) {
    return helioRequest(path, { method, body, refreshToken: true });
  }
  return { response, json };
}

async function n8nRequest(path, init = {}) {
  const response = await fetch(`${N8N_BASE}${path}`, {
    ...init,
    headers: {
      'X-N8N-API-KEY': N8N_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`n8n ${init.method || 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

function listHelioWorkflows(workflows) {
  return workflows
    .filter((workflow) => workflow.name?.includes(`account ${ACCOUNT_ID} inbox ${INBOX_ID}`))
    .map((workflow) => ({ id: workflow.id, name: workflow.name, active: workflow.active }));
}

function verifyIngressWorkflow(workflow) {
  const names = new Set((workflow.nodes || []).map((node) => node.name));
  return [
    ['name looks like ingress', /Ingress/i.test(workflow.name || '')],
    ['has Invoke Support Runtime', names.has('Invoke Support Runtime')],
    ['no Support Agent on ingress', !names.has('Support Agent')],
    ['active', workflow.active === true],
  ];
}

function verifySupportRuntimeWorkflow(workflow) {
  const names = new Set((workflow.nodes || []).map((node) => node.name));
  const normalize = workflow.nodes?.find((node) => node.name === 'Normalize Escalation Lookup');
  return [
    ['name looks like support runtime', /Support Runtime/i.test(workflow.name || '')],
    ['has Support Agent', names.has('Support Agent')],
    ['has Accept Runtime Payload', names.has('Accept Runtime Payload')],
    ['has Load Bot Config', names.has('Load Bot Config')],
    ['policy-driven normalize', /botRuntimeConfig|rewardSources/.test(normalize?.parameters?.jsCode || '')],
    ['no golf reward heuristics', !/golf pass|topshot|loot bag|golf_pass/i.test(normalize?.parameters?.jsCode || '')],
    ['active', workflow.active === true],
    ['revision pin', /helio-support-runtime-v2/.test(workflow.name || '')],
  ];
}

function allChecksPass(checks) {
  return checks.every((entry) => entry[1] === true);
}

function formatChecks(checks) {
  return checks
    .filter((entry) => !entry[1])
    .map((entry) => entry[0])
    .join(', ');
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
      if (result.rows.some((row) => isOutgoingBotMessage(row.message_type))) return result.rows;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return [];
  } finally {
    await client.end();
  }
}

function isOutgoingBotMessage(messageType) {
  return messageType === 1 || messageType === '1' || messageType === 'outgoing';
}

async function findExistingBotId() {
  const client = new pg.Client({ connectionString: CSR_DB });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT ab.id
       FROM agent_bot_inboxes abi
       JOIN agent_bots ab ON ab.id = abi.agent_bot_id
       WHERE abi.inbox_id = $1 AND ab.account_id = $2
       ORDER BY ab.id DESC
       LIMIT 1`,
      [INBOX_ID, ACCOUNT_ID],
    );
    return result.rows[0]?.id ?? null;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('=== Helio provision → reprovision → deprovision E2E ===');
  console.log(`account=${ACCOUNT_ID} inbox=${INBOX_ID}`);

  console.log('\n--- 0. Preflight ---');
  const healthChecks = await Promise.allSettled([
    fetch(`${HELIO_API.replace('/api/v1', '')}/health`),
    fetch(`${FACTORY_BASE}/healthz`),
    fetch(`${N8N_BASE}/healthz`),
  ]);
  record('Helio BE reachable', healthChecks[0].status === 'fulfilled' && healthChecks[0].value.ok);
  record('Bot Factory reachable', healthChecks[1].status === 'fulfilled' && healthChecks[1].value.ok);
  record('n8n reachable', healthChecks[2].status === 'fulfilled' && healthChecks[2].value.ok);
  if (exitCode) {
    console.error('\nStart services first:');
    console.error('  Helio BE: cd MindstormCustomerService-BE && npm run start:dev');
    console.error('  Factory:  cd chatwoot-n8n && npm run factory:start');
    process.exit(exitCode);
  }

  const token = await refreshHelioAuthToken();
  record('Clerk session token', Boolean(token));

  console.log('\n--- 1. Factory template catalog ---');
  const templateResponse = await fetch(`${FACTORY_BASE}/games/progolf/template`, {
    headers: { Authorization: `Bearer ${FACTORY_SECRET}` },
  });
  const templateBody = await templateResponse.json();
  record(
    'GET /games/progolf/template',
    templateResponse.ok &&
      templateBody.gameId === 'progolf' &&
      templateBody.botConfig?.escalationRequirements?.withdrawal,
    `status=${templateResponse.status}`,
  );

  const provisionPayload = {
    name: 'E2E Space Quest Support Bot',
    description: 'Helio E2E ingress/runtime smoke bot',
    gameId: 'space_quest',
    portalSlug: 'progolf',
    systemMessage: 'You are the Space Quest support bot. Be concise and helpful.',
    botConfig: {
      configTtlSeconds: 30,
      taxonomy: {
        categories: ['account', 'technical_bug', 'other'],
        rewardSources: [],
      },
      escalationRequirements: {
        account: {
          items: [{ name: 'player_email', label: 'Email', type: 'email', required: true }],
          required_fields: ['player_email'],
        },
        technical_bug: {
          items: [{ name: 'device', label: 'Device', type: 'text', required: true }],
          required_fields: ['device'],
        },
        other: {
          items: [{ name: 'details', label: 'Details', type: 'text_area', required: true }],
          required_fields: ['details'],
        },
      },
    },
  };

  console.log('\n--- 2. Clean slate: delete existing attached bot ---');
  const existingBotId = await findExistingBotId();
  if (existingBotId) {
    const beforeDelete = await listHelioWorkflows((await n8nRequest('/api/v1/workflows?limit=250')).data || []);
    const deleteResult = await helioRequest(`/accounts/${ACCOUNT_ID}/agent-bots/${existingBotId}`, {
      method: 'DELETE',
    });
    record(
      'DELETE existing agent bot',
      deleteResult.response.ok && deleteResult.json?.deleted === true,
      `botId=${existingBotId} status=${deleteResult.response.status}`,
    );

    const afterDelete = await listHelioWorkflows((await n8nRequest('/api/v1/workflows?limit=250')).data || []);
    const deactivated = beforeDelete
      .filter((workflow) => workflow.active)
      .every((workflow) => {
        const current = afterDelete.find((entry) => entry.id === workflow.id);
        return !current || current.active === false;
      });
    record(
      'Factory deprovision deactivated workflows',
      deactivated || beforeDelete.length === 0,
      `before=${beforeDelete.length} afterActive=${afterDelete.filter((w) => w.active).length}`,
      { critical: false },
    );
  } else {
    record('No existing attached bot to delete', true, 'skipped');
  }

  console.log('\n--- 3. Helio provision-bot ---');
  const provisionResult = await helioRequest(`/accounts/${ACCOUNT_ID}/inboxes/${INBOX_ID}/provision-bot`, {
    method: 'POST',
    body: provisionPayload,
  });
  const provisionedBot = provisionResult.json?.agentBot;
  const provisioning = provisionResult.json?.provisioning;
  const mainWorkflowId = provisioning?.response?.mainWorkflowId || provisioning?.response?.workflowIds?.main;
  const ingressWorkflowId =
    provisioning?.response?.ingressWorkflowId ||
    provisioning?.response?.workflowIds?.ingress ||
    mainWorkflowId;
  const supportRuntimeWorkflowId =
    provisioning?.response?.supportRuntimeWorkflowId ||
    provisioning?.response?.workflowIds?.supportRuntime;
  const runtimeRevision = provisioning?.response?.runtimeRevision;
  record(
    'POST provision-bot',
    provisionResult.response.status === 201 &&
      provisioning?.status === 'active' &&
      provisionedBot?.outgoingUrl &&
      Boolean(ingressWorkflowId && supportRuntimeWorkflowId && runtimeRevision),
    `status=${provisionResult.response.status} botId=${provisionedBot?.id} rev=${runtimeRevision}`,
  );
  if (!provisionedBot?.id) {
    console.error(JSON.stringify(provisionResult.json, null, 2));
    process.exit(1);
  }

  const botId = provisionedBot.id;
  const botToken = provisionedBot.accessToken;

  console.log('\n--- 4. Verify n8n workflows after provision ---');
  record(
    'Provision returned ingress + runtime pin',
    Boolean(ingressWorkflowId && supportRuntimeWorkflowId && runtimeRevision),
    `ingress=${ingressWorkflowId} runtime=${supportRuntimeWorkflowId} rev=${runtimeRevision}`,
  );
  const ingressWorkflow = await n8nRequest(`/api/v1/workflows/${ingressWorkflowId}`);
  const runtimeWorkflow = await n8nRequest(`/api/v1/workflows/${supportRuntimeWorkflowId}`);
  const allWorkflows = (await n8nRequest('/api/v1/workflows?limit=250')).data || [];
  const faqWorkflow = allWorkflows.find((workflow) => /Helio FAQ Sync/i.test(workflow.name || ''));
  const ingressChecks = verifyIngressWorkflow(ingressWorkflow);
  const runtimeChecks = verifySupportRuntimeWorkflow(runtimeWorkflow);
  record(
    'Ingress workflow shape',
    allChecksPass(ingressChecks),
    formatChecks(ingressChecks) || 'ok',
  );
  record(
    'Support runtime workflow shape',
    allChecksPass(runtimeChecks),
    formatChecks(runtimeChecks) || 'ok',
  );
  record(
    'Shared FAQ sync workflow active',
    faqWorkflow?.active === true,
    `id=${faqWorkflow?.id || 'missing'}`,
  );
  const helioWorkflows = listHelioWorkflows(allWorkflows);
  const activeIngress = helioWorkflows.filter(
    (workflow) => workflow.active && /Ingress/i.test(workflow.name),
  );
  record(
    'At most one active ingress for inbox',
    activeIngress.length <= 1,
    `activeIngress=${activeIngress.length} [${activeIngress.map((w) => w.id).join(', ')}]`,
  );

  console.log('\n--- 5. Widget smoke test ---');
  const publicApi = `${HELIO_API.replace('/api/v1', '')}/public/api/v1/inboxes/${WIDGET_ID}`;
  const sourceId = `e2e-${Date.now()}`;
  await fetch(`${publicApi}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, name: 'E2E Player' }),
  });
  const convResponse = await fetch(`${publicApi}/contacts/${sourceId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const conversation = await convResponse.json();
  const msgResponse = await fetch(
    `${publicApi}/contacts/${sourceId}/conversations/${conversation.id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello e2e provision pass' }),
    },
  );
  const sentMessage = await msgResponse.json();
  const replies = await waitForBotReply(conversation.id, sentMessage.id, 60000);
  const botReply = replies.find((row) => isOutgoingBotMessage(row.message_type));
  record(
    'Widget hello gets bot reply',
    Boolean(botReply?.content),
    botReply?.content || 'no reply within 60s',
    { critical: false },
  );

  console.log('\n--- 6. Helio reprovision ---');
  const reprovisionResult = await helioRequest(`/accounts/${ACCOUNT_ID}/agent-bots/${botId}/reprovision`, {
    method: 'POST',
    refreshToken: true,
  });
  const reprovisioned = reprovisionResult.json?.agentBot;
  const reprovisionMeta = reprovisionResult.json?.provisioning;
  const reprovisionMainId =
    reprovisionMeta?.response?.ingressWorkflowId ||
    reprovisionMeta?.response?.workflowIds?.ingress ||
    reprovisionMeta?.response?.mainWorkflowId ||
    reprovisionMeta?.response?.workflowIds?.main;
  const reprovisionRuntimeId =
    reprovisionMeta?.response?.supportRuntimeWorkflowId ||
    reprovisionMeta?.response?.workflowIds?.supportRuntime;
  record(
    'POST reprovision',
    reprovisionResult.response.ok &&
      reprovisionMeta?.status === 'active' &&
      typeof reprovisionMeta?.reprovisionedAt === 'string',
    `status=${reprovisionResult.response.status}`,
  );
  record(
    'Reprovision upserted same ingress + runtime IDs',
    reprovisionMainId === ingressWorkflowId &&
      (!supportRuntimeWorkflowId || reprovisionRuntimeId === supportRuntimeWorkflowId),
    `ingress ${ingressWorkflowId} -> ${reprovisionMainId}, runtime ${supportRuntimeWorkflowId} -> ${reprovisionRuntimeId}`,
  );

  console.log('\n--- 7. Helio delete (cascade deprovision) ---');
  const finalDelete = await helioRequest(`/accounts/${ACCOUNT_ID}/agent-bots/${botId}`, {
    method: 'DELETE',
    refreshToken: true,
  });
  record(
    'DELETE agent bot after reprovision',
    finalDelete.response.ok && finalDelete.json?.deleted === true,
    `status=${finalDelete.response.status}`,
  );

  const postDeleteWorkflows = (await n8nRequest('/api/v1/workflows?limit=250')).data || [];
  const ingressAfter = postDeleteWorkflows.find((workflow) => workflow.id === ingressWorkflowId);
  const runtimeAfter = postDeleteWorkflows.find((workflow) => workflow.id === supportRuntimeWorkflowId);
  const faqAfter = postDeleteWorkflows.find((workflow) => workflow.id === faqWorkflow?.id);
  record(
    'Ingress workflow deactivated on delete',
    ingressAfter?.active === false,
    `active=${ingressAfter?.active}`,
  );
  record(
    'Shared support runtime left active',
    !supportRuntimeWorkflowId || runtimeAfter?.active === true,
    `active=${runtimeAfter?.active}`,
  );
  record(
    'Shared FAQ sync left active',
    !faqWorkflow?.id || faqAfter?.active === true,
    `active=${faqAfter?.active}`,
    { critical: false },
  );

  console.log('\n--- 8. Re-provision to restore local dev bot ---');
  const restoreResult = await helioRequest(`/accounts/${ACCOUNT_ID}/inboxes/${INBOX_ID}/provision-bot`, {
    method: 'POST',
    refreshToken: true,
    body: {
      ...provisionPayload,
      name: 'Space Quest Support Bot',
      description: 'Local dev support bot restored after E2E',
    },
  });
  const restoredBot = restoreResult.json?.agentBot;
  record(
    'Restore local bot after E2E',
    restoreResult.response.ok && restoreResult.json?.provisioning?.status === 'active',
    `botId=${restoredBot?.id} webhook=${restoredBot?.outgoingUrl}`,
  );

  if (restoredBot?.accessToken && restoredBot.accessToken !== botToken) {
    console.log('\nNOTE: Restored bot has a new access token. Update chatwoot-n8n/.env if needed:');
    console.log(`  CHATWOOT_AGENT_BOT_ACCESS_TOKEN=${restoredBot.accessToken}`);
  }

  console.log('\n=== Summary ===');
  for (const entry of results) {
    const label = entry.ok ? 'PASS' : entry.critical === false ? 'WARN' : 'FAIL';
    console.log(`${label} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
