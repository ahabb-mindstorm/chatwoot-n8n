import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FactoryError,
  authenticateFactoryRequest,
  createAndActivateWorkflow,
  deprovisionBotWorkflows,
  patchTaxonomies,
  provisionBotWorkflows,
  ragTableName,
  renderSharedFaqSyncWorkflow,
  renderSharedSupportRuntime,
  renderMainWorkflow,
  SHARED_FAQ_SYNC_WEBHOOK_PATH,
  SHARED_FAQ_SYNC_WORKFLOW_NAME,
  ensureSharedFaqSyncWorkflow,
  upsertAndActivateWorkflow,
  validateBotSpec,
  validateDeprovisionSpec,
} from '../factory/bot-factory.mjs';
import { getGameTemplate, listGameTemplateIds } from '../factory/game-templates.mjs';
import { PROGOLF_CATEGORIES, PROGOLF_REWARD_SOURCES } from '../workflows/progolf-escalation-template.mjs';
import { createFactoryServer } from '../factory/server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadMainTemplate() {
  return JSON.parse(
    readFileSync(join(root, 'workflows', 'progolf-support-bot-v2-pgvector.json'), 'utf8'),
  );
}

test('Factory containers build production dependencies instead of relying on host node_modules', () => {
  const dockerfile = readFileSync(join(root, 'factory', 'Dockerfile'), 'utf8');
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const queueCompose = readFileSync(
    join(root, 'docker-compose.queue.yml'),
    'utf8',
  );

  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(compose, /dockerfile: factory\/Dockerfile/);
  assert.match(queueCompose, /dockerfile: factory\/Dockerfile/);
  const factoryService = (source) =>
    source.split('\n  bot-factory:')[1].split('\nvolumes:')[0];
  assert.doesNotMatch(factoryService(compose), /\.\/:\/app/);
  assert.doesNotMatch(factoryService(queueCompose), /\.\/:\/app/);
});

test('runtime artifact refresh is sourced from the owned generic artifact', () => {
  const source = readFileSync(
    join(root, 'scripts', 'build-support-runtime-artifact.mjs'),
    'utf8',
  );
  assert.match(source, /factory[\s\S]*artifacts[\s\S]*helio-support-runtime\.json/);
  assert.doesNotMatch(source, /progolf-support-bot|workflows/);
});

function validSpec(overrides = {}) {
  return {
    accountId: 42,
    inboxId: 7,
    gameId: 'progolf',
    portalSlug: 'progolf-help',
    helioBaseUrl: 'https://helio.example.test',
    systemMessage: 'You are the Pro Golf support bot.',
    bot: {
      id: 99,
      accessToken: 'bot-access-token-abc',
      webhookSecret: 'webhook-secret-xyz',
    },
    ...overrides,
  };
}

function headersWithSecret(secret, { bearer = true } = {}) {
  if (bearer) {
    return { authorization: `Bearer ${secret}` };
  }
  return { 'x-helio-bot-factory-secret': secret };
}

function createFakeFetch({
  mainId = 'wf-main-1',
  faqSyncId = 'wf-faq-1',
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

    calls.push({ url, path, method, body, headers: init.headers });

    if (method === 'GET' && path === '/api/v1/workflows') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [...workflows.values()] }),
      };
    }

    if (method === 'GET' && /^\/api\/v1\/workflows\/[^/]+$/.test(path)) {
      const workflowId = path.split('/').pop();
      const workflow = workflows.get(workflowId);
      if (!workflow) {
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ message: 'Not found' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(workflow),
      };
    }

    if (method === 'POST' && path === '/api/v1/workflows') {
      const name = String(body?.name || '');
      let id = mainId;
      if (name.includes('FAQ Sync')) id = faqSyncId;
      else if (/Support Runtime/i.test(name)) id = runtimeId;
      else if (/Ingress/i.test(name)) id = ingressId;
      workflows.set(id, {
        id,
        name: body.name,
        active: false,
        updatedAt: '2026-07-07T00:00:00.000Z',
      });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id }),
      };
    }

    if (method === 'PUT' && /^\/api\/v1\/workflows\/[^/]+$/.test(path)) {
      const workflowId = path.split('/').pop();
      const existing = workflows.get(workflowId);
      if (!existing) {
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ message: 'Not found' }),
        };
      }
      const updated = {
        ...existing,
        name: body.name,
        updatedAt: '2026-07-07T01:00:00.000Z',
      };
      workflows.set(workflowId, updated);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(updated),
      };
    }

    if (method === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/activate$/.test(path)) {
      const workflowId = path.split('/').at(-2);
      const workflow = workflows.get(workflowId);
      if (workflow) workflows.set(workflowId, { ...workflow, active: true });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ active: true }),
      };
    }

    if (method === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/deactivate$/.test(path)) {
      const workflowId = path.split('/').at(-2);
      const workflow = workflows.get(workflowId);
      if (workflow) workflows.set(workflowId, { ...workflow, active: false });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ active: false }),
      };
    }

    throw new Error(`Unexpected fetch call: ${method} ${path}`);
  };

  return { fetchImpl, calls, workflows };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('authenticateFactoryRequest accepts Bearer secret and rejects wrong secret', () => {
  const secret = 'factory-secret-token';

  assert.doesNotThrow(() => {
    authenticateFactoryRequest(headersWithSecret(secret), secret);
  });

  assert.throws(
    () => authenticateFactoryRequest(headersWithSecret('wrong-secret'), secret),
    (error) => error instanceof FactoryError && error.statusCode === 401,
  );

  assert.throws(
    () => authenticateFactoryRequest({}, secret),
    (error) => error instanceof FactoryError && error.statusCode === 401,
  );

  assert.throws(
    () => authenticateFactoryRequest(headersWithSecret(secret), ''),
    (error) => error instanceof FactoryError && error.statusCode === 503,
  );
});

test('validateBotSpec requires account, inbox, game, bot token, and webhook secret', () => {
  const spec = validateBotSpec(validSpec());
  assert.equal(spec.accountId, 42);
  assert.equal(spec.inboxId, 7);
  assert.equal(spec.gameId, 'progolf');
  assert.equal(spec.bot.accessToken, 'bot-access-token-abc');
  assert.equal(spec.bot.webhookSecret, 'webhook-secret-xyz');

  const requiredFields = [
    ['accountId', { accountId: undefined }],
    ['inboxId', { inboxId: undefined }],
    ['gameId', { gameId: '' }],
    ['bot.accessToken', { bot: { id: 99, accessToken: '', webhookSecret: 'webhook-secret-xyz' } }],
    ['bot.webhookSecret', { bot: { id: 99, accessToken: 'token', webhookSecret: '' } }],
  ];

  for (const [field, overrides] of requiredFields) {
    assert.throws(
      () => validateBotSpec(validSpec(overrides)),
      (error) => error instanceof FactoryError && error.statusCode === 400 && error.message.includes(field),
      `expected validation error for ${field}`,
    );
  }
});

test('renderMainWorkflow patches webhook path, name, meta, system message, and baked Helio values', () => {
  const template = loadMainTemplate();
  const spec = validateBotSpec(validSpec());
  const webhookPath = 'helio-progolf-42-7-99-bot';
  const webhookBaseUrl = 'https://n8n.example.test';

  const rendered = renderMainWorkflow(template, spec, { webhookPath, webhookBaseUrl });
  const webhookNode = rendered.nodes.find((node) => node.name === 'Chatwoot Bot Events');
  const supportAgent = rendered.nodes.find((node) => node.name === 'Support Agent');
  const loadConfig = rendered.nodes.find((node) => node.name === 'Load Bot Config');
  const escalation = rendered.nodes.find((node) => node.name === 'Load Canonical Escalation Requirements');
  const serialized = JSON.stringify(rendered);

  assert.equal(rendered.name, 'Helio progolf Support Bot - account 42 inbox 7');
  assert.equal(rendered.meta.helioProvisioned, true);
  assert.equal(rendered.meta.gameId, 'progolf');
  assert.equal(rendered.meta.accountId, 42);
  assert.equal(rendered.meta.inboxId, 7);
  assert.equal(rendered.meta.agentBotId, 99);

  assert.equal(webhookNode.parameters.path, webhookPath);
  assert.equal(webhookNode.webhookId, webhookPath);
  assert.match(webhookNode.notes, new RegExp(`${webhookBaseUrl}/webhook/${webhookPath}`));

  assert.match(supportAgent.parameters.options.systemMessage, /Load Bot Config.*botSystemMessage/);
  assert.doesNotMatch(supportAgent.parameters.options.systemMessage, /Pro Caddy/);
  assert.equal(loadConfig.type, 'n8n-nodes-base.code');
  assert.match(loadConfig.parameters.jsCode, /Support Funnel|runtimeContract|Game instructions/);
  assert.match(loadConfig.parameters.jsCode, /helio-support-runtime-v14/);
  assert.match(loadConfig.parameters.jsCode, /api-access-token/);
  assert.match(loadConfig.parameters.jsCode, /configVersion/);
  assert.equal(
    rendered.connections['Restore Debounced Context'].main[0][0].node,
    'Load Bot Config',
  );
  assert.equal(rendered.connections['Load Bot Config'].main[0][0].node, 'Support Agent');

  assert.match(loadConfig.parameters.jsCode, /customData\.set\('ai_triggered'/);
  const extract = rendered.nodes.find((node) => node.name === 'Extract Event');
  assert.match(extract.parameters.jsCode, /customData\.set\('webhook'/);
  assert.equal(escalation.type, 'n8n-nodes-base.code');
  assert.match(escalation.parameters.jsCode, /escalationRequirements/);
  assert.match(escalation.parameters.jsCode, /resolveEscalation/);

  const escalationTool = rendered.nodes.find((node) => node.name === 'Get Escalation Requirements');
  assert.equal(escalationTool.type, '@n8n/n8n-nodes-langchain.toolCode');
  assert.match(escalationTool.parameters.jsCode, /resolveEscalation/);
  assert.match(escalationTool.parameters.jsCode, /getWorkflowStaticData/);
  assert.doesNotMatch(serialized, /YD4d0AAkcvOSSLua/);
  assert.doesNotMatch(serialized, /toolWorkflow/);

  assert.doesNotMatch(serialized, /\$env\.CHATWOOT_/);
  assert.match(serialized, /https:\/\/helio\.example\.test/);
  assert.match(serialized, /bot-access-token-abc/);
  assert.match(serialized, /webhook-secret-xyz/);
  assert.match(serialized, /progolf-help/);
  assert.doesNotMatch(serialized, /api_access_token/);
  assert.match(serialized, /api-access-token/);
});

function expectedRagTableName(spec) {
  return ragTableName(spec);
}

function renderSharedFaqSyncForSpec(optionsOverrides = {}) {
  const webhookBaseUrl = optionsOverrides.webhookBaseUrl || 'https://n8n.example.test';
  return renderSharedFaqSyncWorkflow({ webhookBaseUrl });
}

test('renderSharedFaqSyncWorkflow requires a bearer sync secret before fetching articles', () => {
  const previous = process.env.BOT_FAQ_SYNC_SECRET;
  process.env.BOT_FAQ_SYNC_SECRET = 'faq-sync-secret-test';
  try {
    const rendered = renderSharedFaqSyncForSpec();
    const jsCode = rendered.nodes.find((node) => node.name === 'Sync Bot FAQ Chunks').parameters.jsCode;

    assert.match(jsCode, /faq-sync-secret-test/);
    assert.match(jsCode, /Bearer /);
    assert.match(jsCode, /unauthorized|Unauthorized|FAQ sync secret/i);
    assert.match(jsCode, /HELIO_API_BASE_URL|allowedArticleUrlPrefix|articleUrl must start/i);
  } finally {
    if (previous === undefined) delete process.env.BOT_FAQ_SYNC_SECRET;
    else process.env.BOT_FAQ_SYNC_SECRET = previous;
  }
});

test('renderSharedFaqSyncWorkflow reads sync payload from webhook body', () => {
  const rendered = renderSharedFaqSyncForSpec();
  const syncNode = rendered.nodes.find((node) => node.name === 'Sync Bot FAQ Chunks');
  const jsCode = syncNode.parameters.jsCode;

  assert.equal(syncNode.type, 'n8n-nodes-base.code');
  assert.match(jsCode, /body\.ragTableName/);
  assert.match(jsCode, /body\.articleUrl/);
  assert.match(jsCode, /body\.accessToken/);
  assert.match(jsCode, /headers:\s*\{\s*'api-access-token':\s*botToken/);
  assert.equal(rendered.name, SHARED_FAQ_SYNC_WORKFLOW_NAME);
  assert.doesNotMatch(jsCode, /api_access_token/);
});

test('renderSharedFaqSyncWorkflow embeds FAQ chunks via OpenAI', () => {
  const rendered = renderSharedFaqSyncForSpec();
  const jsCode = rendered.nodes.find((node) => node.name === 'Sync Bot FAQ Chunks').parameters.jsCode;

  assert.match(jsCode, /https:\/\/api\.openai\.com\/v1\/embeddings/);
  assert.match(jsCode, /Authorization:\s*'Bearer '\s*\+\s*apiKey/);
  assert.match(jsCode, /OPENAI_API_KEY is required for FAQ sync embeddings/);
  assert.match(jsCode, /text-embedding-3-small/);
  assert.match(jsCode, /1536-dimensional vectors/);
  assert.match(jsCode, /embedding vector\(1536\)/);
});

test('renderSharedFaqSyncWorkflow scopes stale FAQ cleanup with DELETE not TRUNCATE', () => {
  const rendered = renderSharedFaqSyncForSpec();
  const jsCode = rendered.nodes.find((node) => node.name === 'Sync Bot FAQ Chunks').parameters.jsCode;

  assert.match(jsCode, /DELETE FROM .* WHERE agent_bot_id = .* AND \(/);
  assert.match(jsCode, /article_id NOT IN/);
  assert.doesNotMatch(jsCode, /TRUNCATE/i);
});

test('renderSharedFaqSyncWorkflow creates bot_rag schema and per-request table', () => {
  const rendered = renderSharedFaqSyncForSpec();
  const jsCode = rendered.nodes.find((node) => node.name === 'Sync Bot FAQ Chunks').parameters.jsCode;

  assert.match(jsCode, /CREATE SCHEMA IF NOT EXISTS bot_rag/);
  assert.match(jsCode, /tableName/);
});

test('agent-bot scoped recovery migration filters recover by agent_bot_id', () => {
  const migration = readFileSync(join(root, 'migrations/009_agent_bot_scoped_recovery.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS agent_bot_id/);
  assert.match(migration, /p_agent_bot_id BIGINT DEFAULT NULL/);
  assert.match(migration, /l\.agent_bot_id IS NOT DISTINCT FROM p_agent_bot_id/);
  assert.match(migration, /bot_ingest_event\(/);
  assert.match(migration, /DROP FUNCTION IF EXISTS bot_recover_next_batch\(text, integer, integer\)/);
});

test('Space Quest provision render has no ProGolf vocabulary in patched surfaces', () => {
  const template = loadMainTemplate();
  const spec = validateBotSpec(
    validSpec({
      gameId: 'space_quest',
      portalSlug: 'space-quest-help',
      systemMessage: 'You are the Space Quest support bot.',
      botConfig: {
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
      bot: { id: 55, accessToken: 'space-token', webhookSecret: 'space-secret' },
    }),
  );
  const rendered = renderMainWorkflow(template, spec, {
    webhookPath: 'helio-space_quest-42-7-55-bot',
    webhookBaseUrl: 'https://n8n.example.test',
  });
  const memory = rendered.nodes.find((node) => node.name === 'Postgres Chat Memory');
  const faq = rendered.nodes.find((node) => node.name === 'Search FAQ Knowledge Base');
  const parser = rendered.nodes.find((node) => node.name === 'Agent Output Parser');
  const recover = rendered.nodes.find((node) =>
    String(node.parameters?.query || '').includes('bot_recover_next_batch'),
  );

  assert.equal(memory.parameters.tableName, 'helio_bot_memory_55');
  assert.match(String(memory.parameters.sessionKey), /helio_space_quest_55:/);
  assert.match(String(faq.parameters.toolDescription), /this game's official FAQ/i);
  assert.doesNotMatch(String(faq.parameters.toolDescription), /Pro Golf/i);
  assert.doesNotMatch(String(parser.parameters.inputSchema), /Pro Golf/i);
  assert.doesNotMatch(String(parser.parameters.inputSchema), /golf_pass|topshot|loot_bag/i);
  assert.match(String(recover?.parameters?.query || ''), /,\s*55\s*\)/);
  assert.equal(faq.parameters.tableName, 'bot_rag.faq_space_quest_42_7_55');

  const prepare = rendered.nodes.find((node) => node.name === 'Prepare Durable Event');
  assert.match(prepare.parameters.jsCode, /debounceMs, ', ', 55, '\);'/);

  const banned = [/Pro Golf/i, /progolf/i, /Pro Caddy/i, /golf_pass/i, /topshot/i, /loot_bag/i];
  for (const pattern of banned) {
    assert.doesNotMatch(String(memory.parameters.tableName), pattern);
    assert.doesNotMatch(String(memory.parameters.sessionKey), pattern);
    assert.doesNotMatch(String(faq.parameters.toolDescription), pattern);
    assert.doesNotMatch(String(parser.parameters.inputSchema), pattern);
  }
});

test('renderMainWorkflow scopes Postgres chat memory by agent bot id', () => {
  const template = loadMainTemplate();
  const spec = validateBotSpec(validSpec({ gameId: 'space_quest', bot: { id: 99, accessToken: 't', webhookSecret: 's' } }));
  const rendered = renderMainWorkflow(template, spec, {
    webhookPath: 'helio-space_quest-42-7-99-bot',
    webhookBaseUrl: 'https://n8n.example.test',
  });
  const memory = rendered.nodes.find((node) => node.name === 'Postgres Chat Memory');

  assert.equal(memory.parameters.tableName, 'helio_bot_memory_99');
  assert.match(String(memory.parameters.sessionKey), /helio_space_quest_99:/);
  assert.doesNotMatch(String(memory.parameters.sessionKey), /progolf_support/);
  assert.doesNotMatch(String(memory.parameters.tableName), /progolf/);
});

test('renderMainWorkflow patches FAQ vector store to the same per-bot bot_rag table', () => {
  const spec = validateBotSpec(validSpec());
  const tableName = expectedRagTableName(spec);
  const rendered = renderMainWorkflow(loadMainTemplate(), spec, {
    webhookPath: 'helio-progolf-42-7-99-bot',
    webhookBaseUrl: 'https://n8n.example.test',
  });
  const faqSearch = rendered.nodes.find((node) => node.name === 'Search FAQ Knowledge Base');

  assert.equal(faqSearch.parameters.tableName, tableName);
  assert.notEqual(faqSearch.parameters.tableName, 'progolf_faq_vectors');
});


test('shared support runtime uses policy-driven taxonomy, not ProGolf reward heuristics', () => {
  const runtime = renderSharedSupportRuntime(loadMainTemplate(), {
    webhookBaseUrl: 'https://n8n.example.test',
  });
  const parser = runtime.nodes.find((node) => node.name === 'Agent Output Parser');
  const authorize = runtime.nodes.find(
    (node) => node.name === 'Merge QA With Routing Decision',
  );
  const authorizeCode = String(authorize?.parameters?.jsCode || '');
  const schema = String(parser?.parameters?.inputSchema || '');

  assert.match(authorizeCode, /botRuntimeConfig/);
  assert.match(authorizeCode, /rewardSources/);
  assert.match(authorizeCode, /Accept Runtime Payload/);
  assert.doesNotMatch(authorizeCode, /golf pass|topshot|loot bag|golf_pass|loot_bag/i);
  assert.doesNotMatch(schema, /golf_pass|topshot|loot_bag|reward_pass|special_event|loot_reward/i);
  assert.doesNotMatch(schema, /shot distance|spin|club\/equipment|golf/i);
  assert.doesNotMatch(JSON.stringify(runtime), /### Get Escalation Requirements|Call exactly ONCE/i);
  assert.match(JSON.stringify(runtime), /Published bot policy|escalationRequirements/);
  assert.ok(!runtime.nodes.some((node) => node.name === 'Normalize Escalation Lookup'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'Build Escalation Form'));
});

test('shared support runtime publication loads the owned artifact, not the provision template', () => {
  const sentinelTemplate = {
    name: 'ProGolf sentinel template',
    nodes: [{ name: 'ProGolf Sentinel Node' }],
    connections: {},
  };

  const runtime = renderSharedSupportRuntime(sentinelTemplate, {
    webhookBaseUrl: 'https://n8n.example.test',
  });

  assert.equal(runtime.meta.templateId, 'helio-support-runtime');
  assert.equal(runtime.meta.runtimeRevision, 'helio-support-runtime-v14');
  assert.ok(runtime.nodes.some((node) => node.name === 'Support Agent'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'ProGolf Sentinel Node'));
});

test('shared support runtime authorizes agent proposals through SupportRuntime', () => {
  const runtime = renderSharedSupportRuntime(loadMainTemplate(), {
    webhookBaseUrl: 'https://n8n.example.test',
  });
  const agent = runtime.nodes.find((node) => node.name === 'Support Agent');
  const parser = runtime.nodes.find((node) => node.name === 'Agent Output Parser');
  const authorize = runtime.nodes.find(
    (node) => node.name === 'Merge QA With Routing Decision',
  );
  const routeTurn = runtime.nodes.find((node) => node.name === 'Route Runtime Turn');
  const schema = JSON.parse(parser.parameters.inputSchema);
  const code = String(authorize.parameters.jsCode || '');

  assert.equal(agent.parameters.options.returnIntermediateSteps, true);
  assert.deepEqual(schema.properties.action.enum, [
    'reply',
    'clarify',
    'self_serve',
    'escalate',
    'handoff',
  ]);
  assert.equal(schema.properties.faq_evidence_ids.type, 'array');
  assert.equal(schema.properties.grounding_quotes.type, 'array');
  assert.ok(schema.required.includes('faq_evidence_ids'));
  assert.ok(schema.required.includes('grounding_quotes'));

  assert.match(code, /createSupportRuntime/);
  assert.match(code, /handleTurn/);
  assert.match(code, /intermediateSteps/);
  assert.match(code, /runtimeReceipt/);
  assert.match(code, /executeN8nRuntimeEffects/);
  assert.doesNotMatch(code, /pass_through/);
  assert.doesNotMatch(code, /\bexport\s+/);
  assert.ok(!runtime.nodes.some((node) => node.name === 'Prepare Ticket State Persist'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'Persist Ticket State'));
  assert.equal(runtime.connections['Merge Ticket State'].main[0][0].node, 'Route Runtime Turn');
  assert.equal(runtime.connections['Route Runtime Turn'].main[0][0].node, 'Support Agent');
  assert.equal(
    runtime.connections['Route Runtime Turn'].main[1][0].node,
    'Merge QA With Routing Decision',
  );
  assert.equal(
    runtime.connections['Route Runtime Turn'].main[2][0].node,
    'Merge QA With Routing Decision',
  );
  assert.match(JSON.stringify(routeTurn.parameters), /form_submitted/);
  assert.match(JSON.stringify(routeTurn.parameters), /human_owned/);
  assert.ok(!runtime.nodes.some((node) => node.name === 'Route Requirement Lookup'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'Build Escalation Form'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'Prepare Handoff'));
  assert.ok(!runtime.nodes.some((node) => node.name === 'Claim Send Reply'));
  assert.equal(
    runtime.connections['Merge QA With Routing Decision'].main[0][0].node,
    'Finalize Batch',
  );
});

test('provisionBotWorkflows creates ingress and ensures shared support runtime', async () => {
  const spec = validSpec({
    gameId: 'space_quest',
    portalSlug: 'space-quest-help',
    systemMessage: 'You are the Space Quest support bot.',
    bot: { id: 55, accessToken: 'space-token', webhookSecret: 'space-secret' },
  });
  const { fetchImpl, calls } = createFakeFetch({
    mainId: 'should-not-use-main',
    ingressId: 'ingress-workflow-id',
    runtimeId: 'runtime-workflow-id',
  });

  const result = await provisionBotWorkflows(spec, {
    fetchImpl,
    env: {
      N8N_API_KEY: 'test-n8n-api-key',
      N8N_BASE_URL: 'http://n8n-internal.test',
      WEBHOOK_URL: 'https://public-n8n.example.test',
      BOT_FACTORY_API_SECRET: 'factory-secret',
    },
    mainTemplate: loadMainTemplate(),
  });

  const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/workflows');
  const names = createCalls.map((call) => call.body.name);
  assert.ok(names.some((name) => /Ingress/i.test(name)), `expected ingress in ${names.join(', ')}`);
  assert.ok(
    names.some((name) => /Support Runtime/i.test(name)),
    `expected support runtime in ${names.join(', ')}`,
  );
  assert.ok(!names.some((name) => /ProGolf|Support Bot - account/i.test(name)));

  const ingressBody = createCalls.find((call) => /Ingress/i.test(call.body.name))?.body;
  const runtimeBody = createCalls.find((call) => /Support Runtime/i.test(call.body.name))?.body;
  assert.ok(ingressBody);
  assert.ok(runtimeBody);
  assert.ok(!ingressBody.nodes.some((node) => node.name === 'Support Agent'));
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Invoke Support Runtime'));
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Respond Authorized'));
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Ingest Durable Event'));
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Recover Next Batch'));
  const recover = ingressBody.nodes.find(
    (node) => node.name === 'Recover Next Batch',
  );
  assert.match(recover.parameters.query, /,\s*55\);/);
  assert.deepEqual(ingressBody.connections['Restore Debounced Context'], {
    main: [[{ node: 'Invoke Support Runtime', type: 'main', index: 0 }]],
  });
  assert.ok(runtimeBody.nodes.some((node) => node.name === 'Support Agent'));
  assert.ok(runtimeBody.nodes.some((node) => node.name === 'Accept Runtime Payload'));
  assert.ok(runtimeBody.nodes.some((node) => node.name === 'Load Ticket State'));
  assert.ok(!runtimeBody.nodes.some((node) => node.name === 'Persist Ticket State'));
  assert.deepEqual(runtimeBody.connections['Load Bot Config']?.main?.[0], [
    { node: 'Load Ticket State', type: 'main', index: 0 },
  ]);
  assert.ok(!runtimeBody.nodes.some((node) => node.name === 'Claim Send Reply'));
  assert.ok(!runtimeBody.nodes.some((node) => node.name === 'Send Reply'));
  assert.ok(!runtimeBody.nodes.some((node) => node.name === 'Send Escalation Form'));
  assert.ok(!runtimeBody.nodes.some((node) => node.name === 'Open Conversation'));
  assert.deepEqual(
    runtimeBody.connections['Merge QA With Routing Decision']?.main?.[0],
    [{ node: 'Finalize Batch', type: 'main', index: 0 }],
  );
  const invoke = ingressBody.nodes.find((node) => node.name === 'Invoke Support Runtime');
  assert.match(String(invoke.parameters.url), /n8n-internal\.test\/webhook\/helio-support-runtime/);
  assert.equal(invoke.parameters.sendHeaders, true);
  assert.deepEqual(invoke.parameters.headerParameters.parameters, [
    {
      name: 'x-helio-runtime-secret',
      value: '={{ $env.BOT_FACTORY_API_SECRET }}',
    },
  ]);
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Recovery Schedule'));
  assert.ok(ingressBody.nodes.some((node) => node.name === 'Recover Next Batch'));
  assert.equal(
    ingressBody.connections['Has Claimed Batch?'].main[0][0].node,
    'Invoke Support Runtime',
  );
  assert.match(
    String(invoke.parameters.jsonBody),
    /https:\/\/helio\.example\.test\/api\/v1\/accounts\/42\/agent-bots\/55\/config/,
  );
  assert.doesNotMatch(JSON.stringify(ingressBody), /Pro Golf|Pro Caddy|golf_pass|progolf_support/i);
  assert.doesNotMatch(JSON.stringify(runtimeBody), /Pro Golf|Pro Caddy|golf_pass|progolf_support_agent_memory/i);
  const acceptRuntime = runtimeBody.nodes.find(
    (node) => node.name === 'Accept Runtime Payload',
  );
  assert.match(acceptRuntime.parameters.jsCode, /x-helio-runtime-secret/);
  assert.match(acceptRuntime.parameters.jsCode, /BOT_FACTORY_API_SECRET/);

  assert.equal(result.runtimeRevision, 'helio-support-runtime-v14');
  assert.equal(
    result.webhookUrl,
    'https://public-n8n.example.test/webhook/helio-space-quest-42-7-55-bot',
  );
  assert.equal(result.workflowIds.ingress, 'ingress-workflow-id');
  assert.equal(result.workflowIds.supportRuntime, 'runtime-workflow-id');
  assert.equal(result.ingressWorkflowId, 'ingress-workflow-id');
  assert.equal(result.supportRuntimeWorkflowId, 'runtime-workflow-id');
  assert.equal(result.mainWorkflowId, 'ingress-workflow-id');
});

test('provisionBotWorkflows uses internal base for ingress→runtime invoke', async () => {
  const spec = validSpec({
    gameId: 'space_quest',
    bot: { id: 77, accessToken: 't', webhookSecret: 's' },
  });
  const { fetchImpl, calls } = createFakeFetch({
    ingressId: 'ingress-id',
    runtimeId: 'runtime-id',
  });

  const result = await provisionBotWorkflows(spec, {
    fetchImpl,
    env: {
      N8N_API_KEY: 'test-n8n-api-key',
      N8N_BASE_URL: 'http://n8n:5678',
      WEBHOOK_URL: 'https://public-n8n.example.test',
      BOT_FACTORY_API_SECRET: 'factory-secret',
    },
    mainTemplate: loadMainTemplate(),
  });

  const ingressBody = calls.find(
    (call) => call.method === 'POST' && call.path === '/api/v1/workflows' && /Ingress/i.test(call.body.name),
  )?.body;
  const invoke = ingressBody.nodes.find((node) => node.name === 'Invoke Support Runtime');
  assert.match(String(invoke.parameters.url), /^http:\/\/n8n:5678\/webhook\/helio-support-runtime/);
  assert.match(result.webhookUrl, /^https:\/\/public-n8n\.example\.test\/webhook\//);
  assert.match(result.supportRuntimeInternalWebhookUrl, /^http:\/\/n8n:5678\/webhook\//);
  assert.match(result.supportRuntimeWebhookUrl, /^https:\/\/public-n8n\.example\.test\/webhook\//);
});

test('provisionBotWorkflows upserts existing ingress by deterministic name', async () => {
  const spec = validSpec({ gameId: 'space_quest', bot: { id: 55, accessToken: 't', webhookSecret: 's' } });
  const existingName = `Helio space_quest Ingress - account 42 inbox 7`;
  const runtimeName = `Helio Support Runtime (helio-support-runtime-v14)`;
  const { fetchImpl, calls } = createFakeFetch({
    ingressId: 'existing-ingress',
    runtimeId: 'existing-runtime',
    existingWorkflows: [
      { id: 'existing-ingress', name: existingName, active: true },
      { id: 'existing-runtime', name: runtimeName, active: true },
    ],
  });

  const result = await provisionBotWorkflows(spec, {
    fetchImpl,
    env: {
      N8N_API_KEY: 'test-n8n-api-key',
      N8N_BASE_URL: 'http://n8n-internal.test',
      WEBHOOK_URL: 'https://public-n8n.example.test',
    },
    mainTemplate: loadMainTemplate(),
  });

  const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/workflows');
  const updateCalls = calls.filter((call) => call.method === 'PUT' && call.path.startsWith('/api/v1/workflows/'));
  assert.equal(createCalls.length, 0);
  assert.ok(updateCalls.length >= 1);
  assert.equal(result.ingressWorkflowId, 'existing-ingress');
  assert.equal(result.supportRuntimeWorkflowId, 'existing-runtime');
});

test('getGameTemplate returns progolf starter config with taxonomies and escalation forms', () => {
  const template = getGameTemplate('progolf');

  assert.equal(template.gameId, 'progolf');
  assert.equal(template.templateId, 'progolf-support-bot-v2-pgvector');
  assert.equal(template.name, 'Pro Golf Support Bot');
  assert.deepEqual(template.taxonomy.categories, PROGOLF_CATEGORIES);
  assert.deepEqual(template.taxonomy.rewardSources, PROGOLF_REWARD_SOURCES);
  assert.equal(typeof template.systemMessage, 'string');
  assert.ok(template.systemMessage.length > 1000);
  assert.equal(template.botConfig.configTtlSeconds, 30);
  assert.deepEqual(template.botConfig.taxonomy.categories, PROGOLF_CATEGORIES);
  assert.ok(template.botConfig.escalationRequirements.withdrawal);
  assert.ok(template.botConfig.escalationRequirements.tournament);
  assert.ok(template.botConfig.escalationRequirements.golf_pass);
});

test('patchTaxonomies bakes category and reward-source enums into workflow nodes', () => {
  const template = loadMainTemplate();
  const spec = validateBotSpec(validSpec({
    botConfig: {
      taxonomy: {
        categories: ['withdrawal', 'reward', 'other'],
        rewardSources: ['tournament', 'unknown'],
      },
    },
  }));

  const rendered = patchTaxonomies(
    renderMainWorkflow(template, spec, {
      webhookPath: 'helio-progolf-42-7-99-bot',
      webhookBaseUrl: 'https://n8n.example.test',
    }),
    spec,
  );

  const normalize = rendered.nodes.find((node) => node.name === 'Normalize Escalation Lookup');
  const parser = rendered.nodes.find((node) => node.name === 'Agent Output Parser');
  const schema = JSON.parse(parser.parameters.inputSchema);

  assert.match(normalize.parameters.jsCode, /const categories = \["withdrawal","reward","other"\];/);
  assert.deepEqual(schema.properties.category.enum, ['withdrawal', 'reward', 'other']);
  assert.deepEqual(schema.properties.reward_source.enum, ['', 'tournament', 'unknown']);
});

test('server exposes authenticated game template catalog endpoints', async () => {
  const originalEnv = {
    BOT_FACTORY_API_SECRET: process.env.BOT_FACTORY_API_SECRET,
  };
  const factory = createFactoryServer();
  const factoryUrl = await listen(factory);

  process.env.BOT_FACTORY_API_SECRET = 'factory-secret-token';

  try {
    const listResponse = await fetch(`${factoryUrl}/games`, {
      headers: { Authorization: 'Bearer factory-secret-token' },
    });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listBody.games, listGameTemplateIds());

    const templateResponse = await fetch(`${factoryUrl}/games/progolf/template`, {
      headers: { Authorization: 'Bearer factory-secret-token' },
    });
    const templateBody = await templateResponse.json();
    assert.equal(templateResponse.status, 200);
    assert.equal(templateBody.gameId, 'progolf');
    assert.ok(templateBody.botConfig.escalationRequirements.withdrawal);

    const missingResponse = await fetch(`${factoryUrl}/games/unknown-game/template`, {
      headers: { Authorization: 'Bearer factory-secret-token' },
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    if (originalEnv.BOT_FACTORY_API_SECRET === undefined) {
      delete process.env.BOT_FACTORY_API_SECRET;
    } else {
      process.env.BOT_FACTORY_API_SECRET = originalEnv.BOT_FACTORY_API_SECRET;
    }
    await close(factory);
  }
});

test('server exposes authenticated durable runtime persistence endpoints', async () => {
  const originalSecret = process.env.BOT_FACTORY_API_SECRET;
  const calls = [];
  const runtimePersistence = {
    async findByDeliveryId(scope) {
      calls.push({ operation: 'find', scope });
      return { deliveryId: scope.deliveryId, status: 'completed' };
    },
    async commitTurn(accountId, turn) {
      calls.push({ operation: 'commit', accountId, turn });
      return {
        duplicate: false,
        receipt: {
          deliveryId: turn.deliveryId,
          stateVersion: turn.expectedStateVersion + 1,
          effectIds: [],
        },
      };
    },
    async claimEffect(input) {
      calls.push({ operation: 'claim', input });
      return { shouldRun: true, reason: 'claimed' };
    },
    async completeEffect(input) {
      calls.push({ operation: 'complete', input });
      return { ok: true };
    },
    async failEffect(input) {
      calls.push({ operation: 'fail', input });
      return { ok: true };
    },
  };
  const factory = createFactoryServer({ runtimePersistence });
  const factoryUrl = await listen(factory);
  process.env.BOT_FACTORY_API_SECRET = 'factory-secret-token';

  try {
    const headers = {
      'content-type': 'application/json',
      'x-helio-bot-factory-secret': 'factory-secret-token',
    };
    const findResponse = await fetch(`${factoryUrl}/runtime/turns/find`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId: 7,
        agentBotId: 42,
        conversationId: 9001,
        deliveryId: 'delivery-1',
      }),
    });
    assert.equal(findResponse.status, 200);
    assert.equal((await findResponse.json()).receipt.deliveryId, 'delivery-1');

    const commitResponse = await fetch(`${factoryUrl}/runtime/turns/commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId: 7,
        turn: {
          deliveryId: 'delivery-2',
          agentBotId: 42,
          conversationId: 9001,
          expectedStateVersion: 3,
        },
      }),
    });
    assert.equal(commitResponse.status, 200);
    assert.equal((await commitResponse.json()).receipt.stateVersion, 4);

    for (const [path, body] of [
      [
        'claim',
        {
          accountId: 7,
          agentBotId: 42,
          conversationId: 9001,
          deliveryId: 'delivery-2',
          owner: 'runtime:delivery-2',
          effect: {
            type: 'open_for_human',
            idempotencyKey: 'delivery-2:open',
          },
        },
      ],
      [
        'complete',
        { agentBotId: 42, effectId: 'delivery-2:open', response: { id: 1 } },
      ],
      [
        'fail',
        {
          agentBotId: 42,
          effectId: 'delivery-2:note',
          failureCode: 'effect_execution_failed',
        },
      ],
    ]) {
      const response = await fetch(`${factoryUrl}/runtime/effects/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, path);
    }
    assert.deepEqual(calls.map((call) => call.operation), [
      'find',
      'commit',
      'claim',
      'complete',
      'fail',
    ]);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.BOT_FACTORY_API_SECRET;
    } else {
      process.env.BOT_FACTORY_API_SECRET = originalSecret;
    }
    await close(factory);
  }
});

test('provisionBotWorkflows upserts existing workflows by deterministic name', async () => {
  const spec = validSpec({ gameId: 'space_quest', bot: { id: 55, accessToken: 't', webhookSecret: 's' } });
  const { fetchImpl, calls } = createFakeFetch({
    ingressId: 'ingress-workflow-id',
    runtimeId: 'runtime-workflow-id',
    existingWorkflows: [
      {
        id: 'ingress-workflow-id',
        name: 'Helio space_quest Ingress - account 42 inbox 7',
        active: true,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'runtime-workflow-id',
        name: 'Helio Support Runtime (helio-support-runtime-v14)',
        active: true,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  });

  const result = await provisionBotWorkflows(spec, {
    fetchImpl,
    env: {
      N8N_API_KEY: 'test-n8n-api-key',
      N8N_BASE_URL: 'http://n8n-internal.test',
      WEBHOOK_URL: 'https://public-n8n.example.test',
    },
    mainTemplate: loadMainTemplate(),
  });

  const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/workflows');
  const updateCalls = calls.filter((call) => call.method === 'PUT' && call.path.startsWith('/api/v1/workflows/'));

  assert.equal(createCalls.length, 0);
  assert.ok(updateCalls.length >= 1);
  assert.equal(result.workflowIds.ingress, 'ingress-workflow-id');
  assert.equal(result.workflowIds.supportRuntime, 'runtime-workflow-id');
  assert.equal(result.upserted.ingress, true);
});

test('upsertAndActivateWorkflow deactivates duplicate workflows with the same name', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    mainId: 'wf-main-1',
    existingWorkflows: [
      {
        id: 'wf-main-1',
        name: 'Helio progolf Support Bot - account 42 inbox 7',
        active: true,
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
      {
        id: 'wf-main-dup',
        name: 'Helio progolf Support Bot - account 42 inbox 7',
        active: true,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  });

  const result = await upsertAndActivateWorkflow(
    { name: 'Helio progolf Support Bot - account 42 inbox 7', nodes: [], connections: {} },
    { baseUrl: 'http://n8n-internal.test', apiKey: 'test-key' },
    fetchImpl,
  );

  const deactivateCalls = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/deactivate'));
  const updateCalls = calls.filter((call) => call.method === 'PUT');

  assert.equal(result.id, 'wf-main-1');
  assert.equal(result.upserted, true);
  assert.equal(deactivateCalls.length, 1);
  assert.equal(deactivateCalls[0].path, '/api/v1/workflows/wf-main-dup/deactivate');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].path, '/api/v1/workflows/wf-main-1');
});

test('validateDeprovisionSpec accepts workflowIds or lookup fields', () => {
  const byIds = validateDeprovisionSpec({
    workflowIds: { main: 'main-id', faqSync: 'faq-id' },
  });
  assert.equal(byIds.mainWorkflowId, 'main-id');
  assert.equal(byIds.faqSyncWorkflowId, 'faq-id');

  const byLookup = validateDeprovisionSpec({
    accountId: 42,
    inboxId: 7,
    gameId: 'progolf',
    bot: { id: 99 },
  });
  assert.equal(byLookup.accountId, 42);
  assert.equal(byLookup.inboxId, 7);
  assert.equal(byLookup.gameId, 'progolf');
  assert.equal(byLookup.bot.id, 99);

  assert.throws(
    () => validateDeprovisionSpec({ accountId: 42 }),
    (error) => error instanceof FactoryError && error.statusCode === 400,
  );
});

test('deprovisionBotWorkflows deactivates workflows by stored ids', async () => {
  const { fetchImpl, calls, workflows } = createFakeFetch({
    existingWorkflows: [
      {
        id: 'main-workflow-id',
        name: 'Helio progolf Support Bot - account 42 inbox 7',
        active: true,
      },
      {
        id: 'faq-sync-workflow-id',
        name: 'Helio progolf FAQ Sync Trigger - account 42 inbox 7',
        active: true,
      },
    ],
  });

  const result = await deprovisionBotWorkflows(
    { workflowIds: { main: 'main-workflow-id', faqSync: 'faq-sync-workflow-id' } },
    {
      fetchImpl,
      env: {
        N8N_API_KEY: 'test-n8n-api-key',
        N8N_BASE_URL: 'http://n8n-internal.test',
      },
    },
  );

  const deactivateCalls = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/deactivate'));
  assert.equal(deactivateCalls.length, 2);
  assert.equal(workflows.get('main-workflow-id').active, false);
  assert.equal(workflows.get('faq-sync-workflow-id').active, false);
  assert.equal(result.deactivated.filter((entry) => entry.changed).length, 2);
  assert.deepEqual(result.workflowIds, {
    main: 'main-workflow-id',
    faqSync: 'faq-sync-workflow-id',
  });
});

test('deprovisionBotWorkflows can resolve workflows by deterministic name', async () => {
  const { fetchImpl, workflows } = createFakeFetch({
    existingWorkflows: [
      {
        id: 'main-workflow-id',
        name: 'Helio progolf Support Bot - account 42 inbox 7',
        active: true,
      },
    ],
  });

  const result = await deprovisionBotWorkflows(
    {
      accountId: 42,
      inboxId: 7,
      gameId: 'progolf',
      bot: { id: 99 },
    },
    {
      fetchImpl,
      env: {
        N8N_API_KEY: 'test-n8n-api-key',
        N8N_BASE_URL: 'http://n8n-internal.test',
      },
    },
  );

  assert.equal(workflows.get('main-workflow-id').active, false);
  assert.equal(result.deactivated.length, 1);
});


test('server accepts a Helio-style provision request and returns usable webhook URLs', async () => {
  const originalEnv = {
    BOT_FACTORY_API_SECRET: process.env.BOT_FACTORY_API_SECRET,
    N8N_API_KEY: process.env.N8N_API_KEY,
    N8N_BASE_URL: process.env.N8N_BASE_URL,
    WEBHOOK_URL: process.env.WEBHOOK_URL,
  };
  const createdNames = [];

  const fakeN8n = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/workflows')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/workflows') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      createdNames.push(body.name);
      let id = 'main-id';
      if (body.name.includes('FAQ Sync')) id = 'faq-id';
      else if (/Support Runtime/i.test(body.name)) id = 'runtime-id';
      else if (/Ingress/i.test(body.name)) id = 'ingress-id';
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id }));
      return;
    }

    if (request.method === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/activate$/.test(request.url || '')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ active: true }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const factory = createFactoryServer();
  const fakeN8nUrl = await listen(fakeN8n);
  const factoryUrl = await listen(factory);

  process.env.BOT_FACTORY_API_SECRET = 'factory-secret-token';
  process.env.N8N_API_KEY = 'test-n8n-key';
  process.env.N8N_BASE_URL = fakeN8nUrl;
  process.env.WEBHOOK_URL = 'https://public-n8n.example.test';

  try {
    const response = await fetch(`${factoryUrl}/provision-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer factory-secret-token',
      },
      body: JSON.stringify(validSpec()),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.webhookUrl, 'https://public-n8n.example.test/webhook/helio-progolf-42-7-99-bot');
    assert.equal(body.ragTableName, 'bot_rag.faq_progolf_42_7_99');
    assert.equal(body.runtimeRevision, 'helio-support-runtime-v14');
    assert.deepEqual(body.workflowIds, {
      ingress: 'ingress-id',
      supportRuntime: 'runtime-id',
      main: 'ingress-id',
    });
    assert.deepEqual(createdNames.sort(), [
      'Helio Support Runtime (helio-support-runtime-v14)',
      'Helio progolf Ingress - account 42 inbox 7',
    ]);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await close(factory);
    await close(fakeN8n);
  }
});

test('server accepts deprovision-bot and deactivates stored workflow ids', async () => {
  const originalEnv = {
    BOT_FACTORY_API_SECRET: process.env.BOT_FACTORY_API_SECRET,
    N8N_API_KEY: process.env.N8N_API_KEY,
    N8N_BASE_URL: process.env.N8N_BASE_URL,
  };
  const deactivated = [];

  const fakeN8n = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/workflows/')) {
      const workflowId = request.url.split('/').pop();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: workflowId,
        name: workflowId === 'faq-id' ? 'Helio progolf FAQ Sync Trigger - account 42 inbox 7' : 'Helio progolf Support Bot - account 42 inbox 7',
        active: true,
      }));
      return;
    }

    if (request.method === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/deactivate$/.test(request.url || '')) {
      deactivated.push(request.url);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ active: false }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const factory = createFactoryServer();
  const fakeN8nUrl = await listen(fakeN8n);
  const factoryUrl = await listen(factory);

  process.env.BOT_FACTORY_API_SECRET = 'factory-secret-token';
  process.env.N8N_API_KEY = 'test-n8n-key';
  process.env.N8N_BASE_URL = fakeN8nUrl;

  try {
    const response = await fetch(`${factoryUrl}/deprovision-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer factory-secret-token',
      },
      body: JSON.stringify({
        workflowIds: { main: 'main-id', faqSync: 'faq-id' },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(deactivated.length, 2);
    assert.equal(body.deactivated.filter((entry) => entry.changed).length, 2);
    assert.deepEqual(body.workflowIds, { main: 'main-id', faqSync: 'faq-id' });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await close(factory);
    await close(fakeN8n);
  }
});
test('createAndActivateWorkflow posts workflow then activates it', async () => {
  const { fetchImpl, calls } = createFakeFetch({ mainId: 'created-id-123' });

  const result = await createAndActivateWorkflow(
    { name: 'Test Workflow', nodes: [], connections: {} },
    { baseUrl: 'http://n8n-internal.test', apiKey: 'test-key' },
    fetchImpl,
  );

  assert.deepEqual(result, { id: 'created-id-123' });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /api/v1/workflows',
      'POST /api/v1/workflows/created-id-123/activate',
    ],
  );
  assert.equal(calls[0].headers['X-N8N-API-KEY'], 'test-key');
});
