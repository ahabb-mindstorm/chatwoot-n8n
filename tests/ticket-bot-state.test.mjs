import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('ticket state migration scopes rows by agent_bot_id and exposes load/upsert helpers', () => {
  const migration = readFileSync(join(root, 'migrations/011_agent_bot_scoped_ticket_state.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS agent_bot_id/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS phase/);
  assert.match(migration, /UNIQUE \(account_id, conversation_id, agent_bot_id\)/);
  assert.match(migration, /idle', 'clarify', 'self_serve', 'route', 'handoff', 'human_owned/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION bot_load_ticket_state/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION bot_upsert_ticket_state/);
  assert.match(migration, /ON CONFLICT \(account_id, conversation_id, agent_bot_id\)/);
});
