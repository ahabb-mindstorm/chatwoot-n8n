import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildN8nSupportRuntimeAdapterSource,
  executeN8nRuntimeEffects,
  normalizeN8nFaqEvidence,
  normalizeN8nProposal,
} from '../runtime/n8n-support-runtime-adapter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runtimePersistenceHarness() {
  const receipts = new Map();
  const env = {
    BOT_FACTORY_INTERNAL_URL: 'http://factory.test',
    BOT_FACTORY_API_SECRET: 'factory-secret',
  };
  const context = {
    helpers: {
      async httpRequest({ url, headers, body }) {
        if (!url.startsWith('http://factory.test')) {
          assert.equal(headers.api_access_token, 'bot-token');
          return { id: 1234 };
        }
        assert.equal(headers['x-helio-bot-factory-secret'], 'factory-secret');
        if (url.endsWith('/runtime/turns/find')) {
          return { receipt: receipts.get(body.deliveryId) || null };
        }
        if (url.endsWith('/runtime/effects/claim')) {
          return { shouldRun: true, reason: 'claimed' };
        }
        if (
          url.endsWith('/runtime/effects/complete') ||
          url.endsWith('/runtime/effects/fail')
        ) {
          return { ok: true };
        }
        if (!url.endsWith('/runtime/turns/commit')) {
          throw new Error(`Unexpected persistence URL: ${url}`);
        }
        if (receipts.has(body.turn.deliveryId)) {
          return {
            duplicate: true,
            receipt: receipts.get(body.turn.deliveryId),
          };
        }
        const receipt = {
          deliveryId: body.turn.deliveryId,
          outcome: body.turn.outcome,
          status: body.turn.failureCode ? 'failed_closed' : 'completed',
          runtimeRevision: body.turn.runtimeRevision,
          policyVersion: body.turn.policyVersion,
          stateVersion: Number(body.turn.expectedStateVersion) + 1,
          effectIds: body.turn.effects.map((effect) => effect.idempotencyKey),
          effects: body.turn.effects,
          ...(body.turn.failureCode
            ? { failureCode: body.turn.failureCode }
            : {}),
        };
        receipts.set(body.turn.deliveryId, receipt);
        return { duplicate: false, receipt };
      },
    },
  };
  return { context, env };
}

test('FAQ evidence adapter accepts only current-turn FAQ tool observations', () => {
  const evidence = normalizeN8nFaqEvidence([
    {
      action: { tool: 'Get Escalation Requirements' },
      observation: JSON.stringify({ id: 'not-faq', content: 'Ignore me' }),
    },
    {
      action: { tool: 'Search FAQ Knowledge Base' },
      observation: JSON.stringify([
        {
          document: {
            pageContent: 'Use the reset link on the sign-in screen.',
            metadata: { doc_id: 'faq-reset', title: 'Reset access' },
          },
          score: 0.92,
        },
      ]),
    },
  ]);

  assert.deepEqual(evidence, [
    {
      id: 'faq-reset',
      content: 'Use the reset link on the sign-in screen.',
      title: 'Reset access',
      score: 0.92,
      metadata: { doc_id: 'faq-reset', title: 'Reset access' },
    },
  ]);
});

test('generated n8n adapter delegates turn persistence instead of using workflow static data', () => {
  const supportRuntimeSource = readFileSync(
    join(root, 'runtime', 'support-runtime.mjs'),
    'utf8',
  );
  const source = buildN8nSupportRuntimeAdapterSource(supportRuntimeSource);

  assert.doesNotMatch(source, /\$getWorkflowStaticData/);
  assert.match(source, /BOT_FACTORY_INTERNAL_URL/);
  assert.match(source, /\/runtime\/turns\/find/);
  assert.match(source, /\/runtime\/turns\/commit/);
  assert.match(source, /retryable_runtime_failure/);
  assert.match(source, /\$execution\.id/);
});

test('proposal adapter preserves invalid raw shape for strict validation', () => {
  const proposal = normalizeN8nProposal({
    output: {
      action: 'escalate',
      reply: 42,
      category: 'account',
      summary: '',
      reward_source: '',
      collected_fields: [],
      handoff_override_reason: '',
      faq_evidence_ids: [],
      unexpected_field: true,
    },
  });

  assert.equal(proposal.reply, 42);
  assert.deepEqual(proposal.collectedFields, []);
  assert.equal(proposal.unexpected_field, true);
  assert.equal(Object.hasOwn(proposal, 'groundingQuotes'), false);
});

test('proposal adapter materializes collected fields in the local JavaScript realm', () => {
  const collectedFields = vm.runInNewContext('({ device: "iOS" })');
  const proposal = normalizeN8nProposal({
    output: {
      action: 'reply',
      reply: 'Hello!',
      category: 'other',
      summary: '',
      reward_source: '',
      collected_fields: collectedFields,
      handoff_override_reason: '',
      faq_evidence_ids: [],
      grounding_quotes: [],
    },
  });

  assert.deepEqual(proposal.collectedFields, { device: 'iOS' });
  assert.notEqual(proposal.collectedFields, collectedFields);
  assert.equal(Object.getPrototypeOf(proposal.collectedFields), Object.prototype);
});

test('proposal adapter preserves non-record collected fields for strict validation', () => {
  class Fields {
    constructor() {
      this.device = 'iOS';
    }
  }

  for (const collectedFields of [new Fields(), new Date(), []]) {
    const proposal = normalizeN8nProposal({
      output: {
        action: 'reply',
        reply: 'Hello!',
        category: 'other',
        summary: '',
        reward_source: '',
        collected_fields: collectedFields,
        handoff_override_reason: '',
        faq_evidence_ids: [],
        grounding_quotes: [],
      },
    });

    assert.equal(proposal.collectedFields, collectedFields);
  }
});

test('typed effect executor opens human handoff before noncritical decoration', async () => {
  const calls = [];
  const result = await executeN8nRuntimeEffects({
    receipt: {
      deliveryId: 'delivery-handoff',
      effects: [
        {
          type: 'send_private_note',
          idempotencyKey: 'delivery-handoff:note',
          category: 'account',
          summary: 'Player cannot sign in.',
          collectedValues: { player_id: 'SQ-1' },
          critical: false,
        },
        {
          type: 'open_for_human',
          idempotencyKey: 'delivery-handoff:open',
          critical: true,
        },
      ],
    },
    accept: {
      accountId: 7,
      conversationId: 9001,
      helioRuntime: {
        agentBotId: 42,
        accessToken: 'bot-token',
        helioBaseUrl: 'https://helio.test',
        runtimeRevision: 'helio-support-runtime-v6',
      },
      executionOwner: 'n8n:execution-1001',
    },
    async persistenceRequest(path, body) {
      calls.push({ kind: 'persistence', path, body });
      if (path.endsWith('/claim')) return { shouldRun: true };
      return { ok: true };
    },
    async httpRequest(request) {
      calls.push({ kind: 'helio', request });
      return { id: calls.length };
    },
  });

  const helioCalls = calls.filter((call) => call.kind === 'helio');
  assert.match(helioCalls[0].request.url, /toggle_status$/);
  assert.equal(helioCalls[0].request.body.status, 'open');
  assert.match(helioCalls[1].request.url, /messages$/);
  assert.equal(helioCalls[1].request.body.private, true);
  assert.equal(
    helioCalls[1].request.body.content_attributes.n8n_idempotency_key,
    'delivery-handoff:note',
  );
  assert.deepEqual(result.failedEffectIds, []);
  assert.deepEqual(result.completedEffectIds, [
    'delivery-handoff:open',
    'delivery-handoff:note',
  ]);
  const claims = calls.filter(
    (call) => call.kind === 'persistence' && call.path.endsWith('/claim'),
  );
  assert.ok(claims.every((call) => call.body.owner === 'n8n:execution-1001'));
});

test('typed effect executor leaves failed critical effects retryable', async () => {
  const persistencePaths = [];
  await assert.rejects(
    executeN8nRuntimeEffects({
      receipt: {
        deliveryId: 'delivery-critical-failure',
        effects: [
          {
            type: 'open_for_human',
            idempotencyKey: 'delivery-critical-failure:open',
            critical: true,
          },
        ],
      },
      accept: {
        accountId: 7,
        conversationId: 9001,
        helioRuntime: {
          agentBotId: 42,
          accessToken: 'bot-token',
          helioBaseUrl: 'https://helio.test',
        },
      },
      async persistenceRequest(path) {
        persistencePaths.push(path);
        if (path.endsWith('/claim')) return { shouldRun: true };
        return { ok: true };
      },
      async httpRequest() {
        throw new Error('temporary Helio failure');
      },
    }),
    (error) =>
      error.code === 'critical_effect_failed' &&
      error.execution.failedEffectIds.includes(
        'delivery-critical-failure:open',
      ),
  );
  assert.deepEqual(persistencePaths, [
    '/runtime/effects/claim',
    '/runtime/effects/fail',
  ]);
});

test('typed effect executor retries failed noncritical effects after opening for human', async () => {
  const helioPaths = [];
  await assert.rejects(
    executeN8nRuntimeEffects({
      receipt: {
        deliveryId: 'delivery-decoration-failure',
        effects: [
          {
            type: 'send_private_note',
            idempotencyKey: 'delivery-decoration-failure:note',
            critical: false,
          },
          {
            type: 'open_for_human',
            idempotencyKey: 'delivery-decoration-failure:open',
            critical: true,
          },
        ],
      },
      accept: {
        accountId: 7,
        conversationId: 9001,
        helioRuntime: {
          agentBotId: 42,
          accessToken: 'bot-token',
          helioBaseUrl: 'https://helio.test',
        },
      },
      async persistenceRequest(path) {
        if (path.endsWith('/claim')) return { shouldRun: true };
        return { ok: true };
      },
      async httpRequest(request) {
        helioPaths.push(new URL(request.url).pathname);
        if (request.url.endsWith('/messages')) {
          throw new Error('temporary note failure');
        }
        return { ok: true };
      },
    }),
    (error) =>
      error.code === 'effect_execution_failed' &&
      error.execution.completedEffectIds.includes(
        'delivery-decoration-failure:open',
      ) &&
      error.execution.failedEffectIds.includes(
        'delivery-decoration-failure:note',
      ),
  );
  assert.match(helioPaths[0], /toggle_status$/);
  assert.match(helioPaths[1], /messages$/);
});

test('typed effect executor treats a busy claim as retryable', async () => {
  await assert.rejects(
    executeN8nRuntimeEffects({
      receipt: {
        deliveryId: 'delivery-busy',
        effects: [{
          type: 'send_public_message',
          idempotencyKey: 'delivery-busy:reply',
          text: 'Hello',
          critical: true,
        }],
      },
      accept: {
        accountId: 7,
        conversationId: 9001,
        executionOwner: 'n8n:execution-2',
        helioRuntime: { agentBotId: 42 },
      },
      async persistenceRequest(path) {
        if (path.endsWith('/claim')) {
          return { shouldRun: false, reason: 'busy' };
        }
        throw new Error(`Unexpected persistence path: ${path}`);
      },
      async httpRequest() {
        throw new Error('Busy effects must not execute');
      },
    }),
    (error) =>
      error.code === 'effect_claim_busy' &&
      error.execution.deferredEffectIds.includes('delivery-busy:reply'),
  );
});

test('typed effect executor defers confirmation when opening for human fails', async () => {
  const requestedPaths = [];
  await assert.rejects(
    executeN8nRuntimeEffects({
      receipt: {
        deliveryId: 'delivery-open-failure',
        effects: [
          {
            type: 'open_for_human',
            idempotencyKey: 'delivery-open-failure:open',
            critical: true,
          },
          {
            type: 'send_public_message',
            idempotencyKey: 'delivery-open-failure:reply',
            text: 'Sent to the team.',
            critical: false,
            requires: ['delivery-open-failure:open'],
          },
        ],
      },
      accept: {
        accountId: 7,
        conversationId: 9001,
        executionOwner: 'n8n:execution-3',
        helioRuntime: {
          agentBotId: 42,
          accessToken: 'bot-token',
          helioBaseUrl: 'https://helio.test',
        },
      },
      async persistenceRequest(path) {
        if (path.endsWith('/claim')) return { shouldRun: true };
        return { ok: true };
      },
      async httpRequest(request) {
        requestedPaths.push(new URL(request.url).pathname);
        throw new Error('open failed');
      },
    }),
    (error) =>
      error.code === 'critical_effect_failed' &&
      error.execution.deferredEffectIds.includes('delivery-open-failure:reply'),
  );
  assert.equal(requestedPaths.length, 1);
  assert.match(requestedPaths[0], /toggle_status$/);
});

test('generated n8n adapter executes a grounded proposal through SupportRuntime', async () => {
  const supportRuntimeSource = readFileSync(
    join(root, 'runtime', 'support-runtime.mjs'),
    'utf8',
  );
  const source = buildN8nSupportRuntimeAdapterSource(supportRuntimeSource);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    '$input',
    '$',
    '$getWorkflowStaticData',
    '$env',
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      batchId: 'batch-grounded-1',
      conversationId: 9001,
      messageId: 'message-grounded-1',
      content: 'How do I reset my access?',
      accountId: 7,
      helioRuntime: {
        agentBotId: 42,
        runtimeRevision: 'runtime-test',
        accessToken: 'bot-token',
        helioBaseUrl: 'https://helio.test',
      },
    },
    'Load Bot Config': {
      botConfigVersion: 12,
      runtimeRevision: 'runtime-test',
      botRuntimeConfig: {
        taxonomy: { categories: ['account'], rewardSources: [] },
        escalationRequirements: {
          account: { items: [{ name: 'player_id', label: 'Player ID' }] },
        },
      },
    },
    'Merge Ticket State': {
      ticketState: {
        phase: 'idle',
        supportStateVersion: 0,
        supportState: {},
      },
    },
    'Support Agent': {
      output: {
        action: 'self_serve',
        reply: 'Use the reset link on the sign-in screen.',
        category: 'account',
        summary: '',
        reward_source: '',
        collected_fields: {},
        handoff_override_reason: '',
        faq_evidence_ids: ['faq-reset'],
        grounding_quotes: [
          {
            evidence_id: 'faq-reset',
            quote: 'Use the reset link on the sign-in screen.',
          },
        ],
      },
      intermediateSteps: [
        {
          action: { tool: 'Search FAQ Knowledge Base' },
          observation: JSON.stringify([
            {
              document: {
                pageContent: 'Use the reset link on the sign-in screen.',
                metadata: { doc_id: 'faq-reset' },
              },
            },
          ]),
        },
      ],
    },
  };
  const staticData = {};
  const input = { first: () => ({ json: nodes['Support Agent'] }) };
  const selectNode = (name) => ({ first: () => ({ json: nodes[name] }) });

  const persistence = runtimePersistenceHarness();
  const [result] = await execute.call(
    persistence.context,
    input,
    selectNode,
    () => staticData,
    persistence.env,
  );

  assert.equal(result.json.runtimeReceipt.outcome, 'self_serve');
  assert.equal(result.json.runtimeReceipt.status, 'completed');
  assert.deepEqual(result.json.runtimeReceipt.evidenceIds, ['faq-reset']);
  assert.equal(result.json.runtimeNextState.selfServeAttempted, true);
  assert.equal(result.json.output.action, 'reply');
  assert.equal(result.json.output.qa_status, 'authorized');
  assert.equal(result.json.output.runtime_outcome, 'self_serve');
});

test('generated n8n adapter handles a form submission without executing Support Agent', async () => {
  const supportRuntimeSource = readFileSync(
    join(root, 'runtime', 'support-runtime.mjs'),
    'utf8',
  );
  const source = buildN8nSupportRuntimeAdapterSource(supportRuntimeSource);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    '$input',
    '$',
    '$getWorkflowStaticData',
    '$env',
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      route: 'form_submitted',
      batchId: 'batch-form-1',
      conversationId: 9001,
      messageId: 'message-form-1',
      submittedValues: [{ name: 'email', value: 'player@example.test' }],
      accountId: 7,
      helioRuntime: {
        agentBotId: 42,
        runtimeRevision: 'runtime-test',
        accessToken: 'bot-token',
        helioBaseUrl: 'https://helio.test',
      },
    },
    'Load Bot Config': {
      botConfigVersion: 12,
      runtimeRevision: 'runtime-test',
      botRuntimeConfig: {
        taxonomy: { categories: ['account'], rewardSources: [] },
        escalationRequirements: {
          account: {
            items: [
              { name: 'player_id', label: 'Player ID' },
              { name: 'email', label: 'Email' },
            ],
          },
        },
      },
    },
    'Merge Ticket State': {
      ticketState: {
        phase: 'route',
        supportStateVersion: 4,
        supportState: {
          category: 'account',
          known_fields: { player_id: 'SQ-123' },
          summary: 'The player cannot regain access.',
          self_serve_attempted: true,
        },
      },
    },
  };
  const selectNode = (name) => {
    if (name === 'Support Agent') throw new Error('Support Agent was bypassed');
    return { first: () => ({ json: nodes[name] }) };
  };

  const persistence = runtimePersistenceHarness();
  const [result] = await execute.call(
    persistence.context,
    { first: () => ({ json: nodes['Merge Ticket State'] }) },
    selectNode,
    () => ({}),
    persistence.env,
  );

  assert.equal(result.json.runtimeReceipt.outcome, 'handoff');
  assert.equal(result.json.runtimeReceipt.status, 'completed');
  assert.deepEqual(result.json.runtimeNextState.knownValues, {
    player_id: 'SQ-123',
    email: 'player@example.test',
  });
  assert.equal(result.json.output.action, 'handoff');
});

test('generated n8n adapter suppresses human-owned tickets without executing Support Agent', async () => {
  const supportRuntimeSource = readFileSync(
    join(root, 'runtime', 'support-runtime.mjs'),
    'utf8',
  );
  const source = buildN8nSupportRuntimeAdapterSource(supportRuntimeSource);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    '$input',
    '$',
    '$getWorkflowStaticData',
    '$env',
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      route: 'user_message',
      batchId: 'batch-human-owned-1',
      conversationId: 9001,
      messageId: 'message-human-owned-1',
      content: 'Are you there?',
      accountId: 7,
      helioRuntime: {
        agentBotId: 42,
        runtimeRevision: 'runtime-test',
        accessToken: 'bot-token',
        helioBaseUrl: 'https://helio.test',
      },
    },
    'Load Bot Config': {
      botConfigVersion: 12,
      runtimeRevision: 'runtime-test',
      botRuntimeConfig: { taxonomy: {}, escalationRequirements: {} },
    },
    'Merge Ticket State': {
      ticketState: {
        phase: 'human_owned',
        botStatus: 'human_owned',
        supportStateVersion: 8,
        supportState: {},
      },
    },
  };
  const selectNode = (name) => {
    if (name === 'Support Agent') throw new Error('Support Agent was bypassed');
    return { first: () => ({ json: nodes[name] }) };
  };

  const persistence = runtimePersistenceHarness();
  const [result] = await execute.call(
    persistence.context,
    { first: () => ({ json: nodes['Merge Ticket State'] }) },
    selectNode,
    () => ({}),
    persistence.env,
  );

  assert.equal(result.json.runtimeReceipt.outcome, 'ignored');
  assert.deepEqual(result.json.runtimeReceipt.effects, []);
  assert.equal(result.json.output.action, 'ignored');
});
