import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  memorySessionPrefix,
  memoryTableName,
  provisionBotWorkflows,
  ragTableName,
  validateBotSpec,
} from '../factory/bot-factory.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadMainTemplate() {
  return JSON.parse(
    readFileSync(join(root, 'workflows', 'progolf-support-bot-v2-pgvector.json'), 'utf8'),
  );
}

function spaceQuestSpec(botId = 55) {
  return validateBotSpec({
    accountId: 42,
    inboxId: 7,
    gameId: 'space_quest',
    portalSlug: 'space-quest-help',
    helioBaseUrl: 'https://helio.example.test',
    systemMessage: 'You are the Space Quest support bot.',
    bot: { id: botId, accessToken: `token-${botId}`, webhookSecret: `secret-${botId}` },
  });
}

function createFakeFetch({
  mainId = 'wf-main-1',
  ingressId = 'wf-ingress-1',
  runtimeId = 'wf-runtime-1',
  existingWorkflows = [],
} = {}) {
  const calls = [];
  const workflows = new Map(
    existingWorkflows.map((workflow) => [
      workflow.id,
      {
        id: workflow.id,
        name: workflow.name,
        active: Boolean(workflow.active),
        updatedAt: workflow.updatedAt || '2026-01-01T00:00:00.000Z',
      },
    ]),
  );

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, path, method, body });

    if (method === 'GET' && path === '/api/v1/workflows') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [...workflows.values()] }) };
    }
    if (method === 'GET' && /^\/api\/v1\/workflows\/[^/]+$/.test(path)) {
      const workflow = workflows.get(path.split('/').pop());
      if (!workflow) return { ok: false, status: 404, text: async () => '{}' };
      return { ok: true, status: 200, text: async () => JSON.stringify(workflow) };
    }
    if (method === 'POST' && path === '/api/v1/workflows') {
      const name = String(body?.name || '');
      let id = mainId;
      if (/Support Runtime/i.test(name)) id = runtimeId;
      else if (/Ingress/i.test(name)) id = ingressId;
      workflows.set(id, { id, name: body.name, active: false, updatedAt: '2026-07-07T00:00:00.000Z' });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id }) };
    }
    if (method === 'PUT' && /^\/api\/v1\/workflows\/[^/]+$/.test(path)) {
      const workflowId = path.split('/').pop();
      const updated = { ...workflows.get(workflowId), name: body.name, ...body };
      workflows.set(workflowId, updated);
      return { ok: true, status: 200, text: async () => JSON.stringify(updated) };
    }
    if (method === 'POST' && /\/(activate|deactivate)$/.test(path)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ active: path.endsWith('/activate') }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  return { fetchImpl, calls };
}

test('factory memory and RAG identifiers are distinct per agent bot', () => {
  const botA = spaceQuestSpec(11);
  const botB = spaceQuestSpec(22);

  assert.equal(ragTableName(botA), 'bot_rag.faq_space_quest_42_7_11');
  assert.equal(ragTableName(botB), 'bot_rag.faq_space_quest_42_7_22');
  assert.notEqual(ragTableName(botA), ragTableName(botB));

  assert.equal(memoryTableName(botA), 'helio_bot_memory_11');
  assert.equal(memoryTableName(botB), 'helio_bot_memory_22');
  assert.notEqual(memoryTableName(botA), memoryTableName(botB));

  assert.equal(memorySessionPrefix(botA), 'helio_space_quest_11:');
  assert.equal(memorySessionPrefix(botB), 'helio_space_quest_22:');
  assert.notEqual(memorySessionPrefix(botA), memorySessionPrefix(botB));
});

test('scoped claim migration filters pending events by agent_bot_id and threads recover', () => {
  const migration = readFileSync(join(root, 'migrations/010_agent_bot_scoped_claim.sql'), 'utf8');
  assert.match(migration, /DROP FUNCTION IF EXISTS bot_claim_conversation_batch\(bigint, bigint, text, integer, integer\)/);
  assert.match(migration, /ADD PRIMARY KEY \(account_id, conversation_id, agent_bot_id\)/);
  assert.match(migration, /ON CONFLICT \(account_id, conversation_id, agent_bot_id\)/);
  assert.match(migration, /p_agent_bot_id BIGINT DEFAULT NULL/);
  assert.match(migration, /COALESCE\(e\.agent_bot_id, 0\) = v_agent_bot_id/);
  assert.match(
    migration,
    /bot_claim_conversation_batch\(\s*v_account_id,\s*v_conversation_id,\s*p_owner,\s*0,\s*p_lease_seconds,\s*v_lease_bot_id\s*\)/,
  );
});

test('unscoped recover migration only touches legacy agent_bot_id 0', () => {
  const migration = readFileSync(join(root, 'migrations/012_unscoped_recover_legacy_only.sql'), 'utf8');
  assert.match(migration, /v_agent_bot_id BIGINT := COALESCE\(p_agent_bot_id, 0\)/);
  assert.match(migration, /AND l\.agent_bot_id = v_agent_bot_id/);
  assert.doesNotMatch(migration, /p_agent_bot_id IS NULL OR l\.agent_bot_id/);
});

test('Helio ingress provision stamps ingest + claim with agentBotId and isolates runtime memory/RAG', async () => {
  const botA = spaceQuestSpec(55);
  const botB = spaceQuestSpec(77);
  const { fetchImpl, calls } = createFakeFetch({
    ingressId: 'ingress-a',
    runtimeId: 'runtime-shared',
  });

  await provisionBotWorkflows(botA, {
    fetchImpl,
    env: {
      N8N_API_KEY: 'test-key',
      N8N_BASE_URL: 'http://n8n-internal.test',
      WEBHOOK_URL: 'https://public-n8n.example.test',
      BOT_FACTORY_API_SECRET: 'factory-secret',
    },
    mainTemplate: loadMainTemplate(),
  });

  const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/workflows');
  const ingressA = createCalls.find((call) => /Ingress/i.test(call.body.name))?.body;
  assert.ok(ingressA, 'expected ingress workflow create');

  const prepare = ingressA.nodes.find((node) => node.name === 'Prepare Durable Event');
  assert.match(String(prepare?.parameters?.jsCode || ''), /debounceMs, ', ', 55, '\);'/);

  const claim = ingressA.nodes.find((node) => node.name === 'Claim Debounced Batch');
  assert.match(String(claim?.parameters?.query || ''), /, 55\);"/);

  const invokeBody = String(
    ingressA.nodes.find((node) => node.name === 'Invoke Support Runtime')?.parameters?.jsonBody || '',
  );
  assert.match(invokeBody, /agentBotId: 55/);
  assert.match(invokeBody, /bot_rag\.faq_space_quest_42_7_55/);
  assert.match(invokeBody, /helio_bot_memory_55/);
  assert.match(invokeBody, /helio_space_quest_55:/);

  const { fetchImpl: fetchB, calls: callsB } = createFakeFetch({
    ingressId: 'ingress-b',
    runtimeId: 'runtime-shared',
  });
  await provisionBotWorkflows(botB, {
    fetchImpl: fetchB,
    env: {
      N8N_API_KEY: 'test-key',
      N8N_BASE_URL: 'http://n8n-internal.test',
      WEBHOOK_URL: 'https://public-n8n.example.test',
      BOT_FACTORY_API_SECRET: 'factory-secret',
    },
    mainTemplate: loadMainTemplate(),
  });

  const ingressB = callsB
    .filter((call) => call.method === 'POST' && call.path === '/api/v1/workflows')
    .find((call) => /Ingress/i.test(call.body.name))?.body;
  const invokeB = String(
    ingressB?.nodes?.find((node) => node.name === 'Invoke Support Runtime')?.parameters?.jsonBody || '',
  );
  assert.match(invokeB, /agentBotId: 77/);
  assert.match(invokeB, /bot_rag\.faq_space_quest_42_7_77/);
  assert.match(invokeB, /helio_bot_memory_77/);
  assert.doesNotMatch(invokeB, /helio_bot_memory_55|faq_space_quest_42_7_55/);

  const claimB = String(
    ingressB?.nodes?.find((node) => node.name === 'Claim Debounced Batch')?.parameters?.query || '',
  );
  assert.match(claimB, /, 77\);"/);
  assert.doesNotMatch(claimB, /, 55\);"/);
});
