import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildN8nSupportRuntimeAdapterSource,
  normalizeN8nFaqEvidence,
} from '../runtime/n8n-support-runtime-adapter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      batchId: 'batch-grounded-1',
      conversationId: 9001,
      messageId: 'message-grounded-1',
      content: 'How do I reset my access?',
      helioRuntime: { agentBotId: 42, runtimeRevision: 'runtime-test' },
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

  const [result] = await execute(input, selectNode, () => staticData);

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
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      route: 'form_submitted',
      batchId: 'batch-form-1',
      conversationId: 9001,
      messageId: 'message-form-1',
      submittedValues: [{ name: 'email', value: 'player@example.test' }],
      helioRuntime: { agentBotId: 42, runtimeRevision: 'runtime-test' },
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

  const [result] = await execute(
    { first: () => ({ json: nodes['Merge Ticket State'] }) },
    selectNode,
    () => ({}),
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
    source,
  );
  const nodes = {
    'Accept Runtime Payload': {
      route: 'user_message',
      batchId: 'batch-human-owned-1',
      conversationId: 9001,
      messageId: 'message-human-owned-1',
      content: 'Are you there?',
      helioRuntime: { agentBotId: 42, runtimeRevision: 'runtime-test' },
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

  const [result] = await execute(
    { first: () => ({ json: nodes['Merge Ticket State'] }) },
    selectNode,
    () => ({}),
  );

  assert.equal(result.json.runtimeReceipt.outcome, 'ignored');
  assert.deepEqual(result.json.runtimeReceipt.effects, []);
  assert.equal(result.json.output.action, 'ignored');
});
