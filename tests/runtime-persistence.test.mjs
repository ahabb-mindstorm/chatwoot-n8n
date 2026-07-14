import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  RuntimePersistenceError,
  createPostgresRuntimePersistence,
} from '../factory/runtime-persistence.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Postgres runtime persistence scopes receipt lookup and delegates atomic commit', async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM bot_support_turns')) {
        return { rows: [{ receipt: { deliveryId: 'delivery-1' } }] };
      }
      return {
        rows: [
          {
            result: {
              duplicate: false,
              receipt: {
                deliveryId: 'delivery-2',
                stateVersion: 4,
                effectIds: ['delivery-2:public-reply'],
              },
            },
          },
        ],
      };
    },
  };
  const persistence = createPostgresRuntimePersistence(pool);

  const receipt = await persistence.findByDeliveryId({
    accountId: 7,
    agentBotId: 42,
    conversationId: 9001,
    deliveryId: 'delivery-1',
  });
  assert.equal(receipt.deliveryId, 'delivery-1');
  assert.deepEqual(queries[0].values, [7, 42, 9001, 'delivery-1']);

  const committed = await persistence.commitTurn(7, {
    deliveryId: 'delivery-2',
    agentBotId: 42,
    conversationId: 9001,
    expectedStateVersion: 3,
    outcome: 'reply',
    nextState: { phase: 'idle', knownValues: {} },
    effects: [
      {
        type: 'send_public_message',
        idempotencyKey: 'delivery-2:public-reply',
        text: 'Hello',
        critical: true,
      },
    ],
    runtimeRevision: 'helio-support-runtime-v5',
    policyVersion: 12,
  });
  assert.equal(committed.duplicate, false);
  assert.equal(committed.receipt.stateVersion, 4);
  assert.match(queries[1].text, /bot_commit_support_turn/);
  assert.equal(queries[1].values[4], 3);
  assert.deepEqual(JSON.parse(queries[1].values[7]), [
    {
      type: 'send_public_message',
      idempotencyKey: 'delivery-2:public-reply',
      text: 'Hello',
      critical: true,
    },
  ]);
});

test('Postgres runtime persistence exposes optimistic conflicts without retrying effects', async () => {
  const pool = {
    async query() {
      const error = new Error('ticket state version conflict');
      error.code = '40001';
      throw error;
    },
  };
  const persistence = createPostgresRuntimePersistence(pool);

  await assert.rejects(
    persistence.commitTurn(7, {
      deliveryId: 'delivery-conflict',
      agentBotId: 42,
      conversationId: 9001,
      expectedStateVersion: 3,
      outcome: 'reply',
      nextState: { phase: 'idle' },
      effects: [],
      runtimeRevision: 'helio-support-runtime-v5',
      policyVersion: 12,
    }),
    (error) =>
      error instanceof RuntimePersistenceError &&
      error.statusCode === 409 &&
      error.details.code === 'ticket_state_conflict',
  );
});

test('Postgres runtime persistence claims and finalizes typed effects independently', async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('bot_claim_outbound_effect')) {
        return { rows: [{ should_run: true, effect_key: values[3], reason: 'claimed' }] };
      }
      return { rows: [{ ok: true }] };
    },
  };
  const persistence = createPostgresRuntimePersistence(pool);
  const effect = {
    type: 'open_for_human',
    idempotencyKey: 'delivery-1:open',
    critical: true,
  };

  const claim = await persistence.claimEffect({
    accountId: 7,
    agentBotId: 42,
    conversationId: 9001,
    deliveryId: 'delivery-1',
    owner: 'runtime:delivery-1',
    effect,
  });
  assert.deepEqual(claim, { shouldRun: true, reason: 'claimed' });

  await persistence.completeEffect({
    agentBotId: 42,
    effectId: effect.idempotencyKey,
    response: { id: 123 },
    remoteId: '123',
  });
  await persistence.failEffect({
    agentBotId: 42,
    effectId: 'delivery-1:note',
    failureCode: 'effect_execution_failed',
  });

  assert.match(queries[0].text, /bot_claim_outbound_effect/);
  assert.match(queries[2].text, /status = 'completed'/);
  assert.match(queries[3].text, /status = 'failed'/);
  assert.equal(queries[3].values[0], 42);
});

test('support runtime migration commits receipt, state version, and pending effects together', () => {
  const migration = readFileSync(
    join(root, 'migrations', '013_support_runtime_turns.sql'),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS bot_support_turns/);
  assert.match(migration, /UNIQUE \(agent_bot_id, delivery_id\)/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /support_state_version = p_expected_state_version/);
  assert.match(migration, /RAISE EXCEPTION 'ticket state version conflict'.*40001/s);
  assert.match(migration, /INSERT INTO bot_outbound_effects/);
  assert.match(migration, /'pending', 0/);
  assert.match(migration, /UPDATE bot_support_turns[\s\S]*receipt = v_receipt/);
});

test('support runtime migration runner applies every generic runtime prerequisite in order', () => {
  const source = readFileSync(
    new URL('../scripts/apply-support-runtime-migration.mjs', import.meta.url),
    'utf8',
  );
  const ordered = [
    '001_bot_support_state.sql',
    '003_support_state.sql',
    '006_idempotency_debounce.sql',
    '007_agent_bot_kill_switch.sql',
    '009_agent_bot_scoped_recovery.sql',
    '010_agent_bot_scoped_claim.sql',
    '011_agent_bot_scoped_ticket_state.sql',
    '012_unscoped_recover_legacy_only.sql',
    '013_support_runtime_turns.sql',
  ];
  let cursor = -1;
  for (const migration of ordered) {
    const next = source.indexOf(migration);
    assert.ok(next > cursor, `${migration} must follow its prerequisites`);
    cursor = next;
  }
});

test('support runtime effects are idempotent within agent-bot scope', () => {
  const migration = readFileSync(
    new URL('../migrations/013_support_runtime_turns.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /UNIQUE \(agent_bot_id, effect_key\)/);
  assert.match(
    migration,
    /bot_outbound_effects\.agent_bot_id = COALESCE\(p_agent_bot_id, 0\)/,
  );
  assert.match(migration, /WHERE agent_bot_id = 0\s+AND effect_key = p_effect_key/);
});
