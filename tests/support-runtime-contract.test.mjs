import assert from 'node:assert/strict';
import test from 'node:test';

import { createSupportRuntime } from '../runtime/support-runtime.mjs';

test('a vague player problem produces a clarification turn through handleTurn', async () => {
  const commits = [];
  const runtime = createSupportRuntime({
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 7,
          gameInstructions: 'You support Space Quest players.',
          taxonomy: { categories: [{ id: 'technical', label: 'Technical' }] },
          escalationRequirements: {
            technical: {
              items: [{ name: 'device', label: 'Device', type: 'text' }],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return { version: 0, phase: 'idle', knownValues: {} };
      },
    },
    knowledge: {
      async search() {
        return [];
      },
    },
    model: {
      async propose() {
        return {
          action: 'clarify',
          reply: 'What happens when you try to launch the game?',
        };
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return { stateVersion: 1, effectIds: ['effect-1'] };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-1',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'player_message',
        messageId: 'message-1',
        text: 'It is broken',
        attachments: [],
      },
    ],
  });

  assert.equal(receipt.outcome, 'clarify');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.policyVersion, 7);
  assert.equal(receipt.stateVersion, 1);
  assert.deepEqual(receipt.effects, [
    {
      type: 'send_public_message',
      idempotencyKey: 'delivery-1:public-reply',
      text: 'What happens when you try to launch the game?',
      critical: true,
    },
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].nextState.phase, 'clarify');
});

test('a factual self-service reply requires current-turn FAQ evidence', async () => {
  const commits = [];
  const runtime = createSupportRuntime({
    runtimeRevision: 'helio-support-runtime-v3',
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 8,
          gameInstructions: 'You support Space Quest players.',
          taxonomy: { categories: [{ id: 'account', label: 'Account' }] },
          escalationRequirements: {
            account: {
              items: [{ name: 'player_id', label: 'Player ID', type: 'text' }],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return { version: 2, phase: 'clarify', knownValues: {} };
      },
    },
    knowledge: {
      async search() {
        return [
          {
            id: 'faq-password-reset',
            title: 'Resetting a password',
            content: 'Use the Forgot Password link on the sign-in screen.',
            score: 0.91,
          },
        ];
      },
    },
    model: {
      async propose() {
        return {
          action: 'self_serve',
          reply: 'Use the Forgot Password link on the sign-in screen.',
          faqEvidenceIds: ['faq-password-reset'],
        };
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return { stateVersion: 3, effectIds: ['effect-2'] };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-2',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'player_message',
        messageId: 'message-2',
        text: 'How do I reset my password?',
        attachments: [],
      },
    ],
  });

  assert.equal(receipt.outcome, 'self_serve');
  assert.equal(receipt.runtimeRevision, 'helio-support-runtime-v3');
  assert.deepEqual(receipt.evidenceIds, ['faq-password-reset']);
  assert.equal(commits[0].nextState.phase, 'self_serve');
  assert.equal(commits[0].nextState.selfServeAttempted, true);
});

test('an unresolved problem produces a form containing only missing escalation requirements', async () => {
  const commits = [];
  const runtime = createSupportRuntime({
    runtimeRevision: 'helio-support-runtime-v3',
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 9,
          gameInstructions: 'You support Space Quest players.',
          taxonomy: { categories: [{ id: 'account', label: 'Account' }] },
          escalationRequirements: {
            account: {
              title: 'Account support details',
              items: [
                { name: 'player_id', label: 'Player ID', type: 'text' },
                { name: 'email', label: 'Email', type: 'email' },
              ],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return {
          version: 3,
          phase: 'self_serve',
          knownValues: {},
          selfServeAttempted: true,
        };
      },
    },
    knowledge: {
      async search() {
        return [];
      },
    },
    model: {
      async propose() {
        return {
          action: 'escalate',
          category: 'account',
          summary: 'The player cannot regain access after trying password reset.',
          collectedFields: { player_id: 'SQ-123' },
        };
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return { stateVersion: 4, effectIds: ['effect-3'] };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-3',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'player_message',
        messageId: 'message-3',
        text: 'That reset did not work. My player ID is SQ-123.',
        attachments: [],
      },
    ],
  });

  assert.equal(receipt.outcome, 'request_form');
  assert.deepEqual(receipt.effects, [
    {
      type: 'send_form',
      idempotencyKey: 'delivery-3:escalation-form',
      category: 'account',
      title: 'Account support details',
      fields: [{ name: 'email', label: 'Email', type: 'email' }],
      knownValues: { player_id: 'SQ-123' },
      attachmentConfig: null,
      critical: true,
    },
  ]);
  assert.equal(commits[0].nextState.phase, 'request_form');
  assert.equal(commits[0].nextState.category, 'account');
  assert.deepEqual(commits[0].nextState.knownValues, { player_id: 'SQ-123' });
});

test('a complete form submission produces an independent critical handoff effect', async () => {
  const commits = [];
  let modelCalled = false;
  const runtime = createSupportRuntime({
    runtimeRevision: 'helio-support-runtime-v3',
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 9,
          gameInstructions: 'You support Space Quest players.',
          taxonomy: { categories: [{ id: 'account', label: 'Account' }] },
          escalationRequirements: {
            account: {
              title: 'Account support details',
              items: [
                { name: 'player_id', label: 'Player ID', type: 'text' },
                { name: 'email', label: 'Email', type: 'email' },
              ],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return {
          version: 4,
          phase: 'request_form',
          category: 'account',
          summary: 'The player cannot regain access after trying password reset.',
          knownValues: { player_id: 'SQ-123' },
          selfServeAttempted: true,
        };
      },
    },
    knowledge: {
      async search() {
        return [];
      },
    },
    model: {
      async propose() {
        modelCalled = true;
        throw new Error('form submission must not require the model');
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return {
          stateVersion: 5,
          effectIds: ['note-1', 'label-1', 'reply-1', 'open-1'],
        };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-4',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'form_submitted',
        messageId: 'message-4',
        values: { email: 'player@example.com' },
        attachments: [],
      },
    ],
  });

  assert.equal(modelCalled, false);
  assert.equal(receipt.outcome, 'handoff');
  assert.deepEqual(
    receipt.effects.map((effect) => effect.type),
    ['send_private_note', 'set_label', 'send_public_message', 'open_for_human'],
  );
  const openEffect = receipt.effects.find(
    (effect) => effect.type === 'open_for_human',
  );
  assert.equal(openEffect.critical, true);
  assert.equal('dependsOn' in openEffect, false);
  assert.equal(
    receipt.effects.find((effect) => effect.type === 'set_label').critical,
    false,
  );
  assert.equal(commits[0].nextState.phase, 'handoff');
  assert.deepEqual(commits[0].nextState.knownValues, {
    player_id: 'SQ-123',
    email: 'player@example.com',
  });
});

test('fabricated FAQ evidence fails closed without publishing the proposed answer', async () => {
  const commits = [];
  const runtime = createSupportRuntime({
    runtimeRevision: 'helio-support-runtime-v3',
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 10,
          gameInstructions: 'You support Space Quest players.',
          taxonomy: { categories: [{ id: 'technical', label: 'Technical' }] },
          escalationRequirements: {
            technical: {
              items: [{ name: 'device', label: 'Device', type: 'text' }],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return { version: 5, phase: 'clarify', knownValues: {} };
      },
    },
    knowledge: {
      async search() {
        return [{ id: 'faq-real', content: 'Verified troubleshooting.' }];
      },
    },
    model: {
      async propose() {
        return {
          action: 'self_serve',
          reply: 'Invented instructions that must not reach the player.',
          faqEvidenceIds: ['faq-invented'],
        };
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return { stateVersion: 6, effectIds: ['safe-reply', 'open'] };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-5',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'player_message',
        messageId: 'message-5',
        text: 'What should I do?',
        attachments: [],
      },
    ],
  });

  assert.equal(receipt.outcome, 'handoff');
  assert.equal(receipt.status, 'failed_closed');
  assert.equal(receipt.failureCode, 'invalid_runtime_proposal');
  assert.equal(
    receipt.effects.some((effect) =>
      String(effect.text || '').includes('Invented instructions'),
    ),
    false,
  );
  assert.equal(
    receipt.effects.find((effect) => effect.type === 'open_for_human').critical,
    true,
  );
  assert.equal(commits[0].nextState.phase, 'handoff');
});

test('a human-owned ticket is finalized without invoking the model or producing effects', async () => {
  const commits = [];
  let modelCalled = false;
  const runtime = createSupportRuntime({
    runtimeRevision: 'helio-support-runtime-v3',
    policySnapshots: {
      async getPublished() {
        return {
          configVersion: 10,
          taxonomy: { categories: [{ id: 'technical', label: 'Technical' }] },
          escalationRequirements: {
            technical: {
              items: [{ name: 'device', label: 'Device', type: 'text' }],
            },
          },
        };
      },
    },
    ticketStates: {
      async load() {
        return {
          version: 6,
          phase: 'human_owned',
          category: 'technical',
          knownValues: { device: 'PC' },
        };
      },
    },
    knowledge: {
      async search() {
        throw new Error('human-owned ticket must not search FAQs');
      },
    },
    model: {
      async propose() {
        modelCalled = true;
        throw new Error('human-owned ticket must not invoke the model');
      },
    },
    turns: {
      async findByDeliveryId() {
        return null;
      },
      async commit(turn) {
        commits.push(turn);
        return { stateVersion: 6, effectIds: [] };
      },
    },
  });

  const receipt = await runtime.handleTurn({
    deliveryId: 'delivery-6',
    agentBotId: 42,
    conversationId: 9001,
    events: [
      {
        type: 'player_message',
        messageId: 'message-6',
        text: 'One more detail for the human agent.',
        attachments: [],
      },
    ],
  });

  assert.equal(modelCalled, false);
  assert.equal(receipt.outcome, 'ignored');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.effects, []);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].nextState.phase, 'human_owned');
});
