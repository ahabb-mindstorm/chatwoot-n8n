import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  escalationResolverNodeJsCode,
  escalationResolverToolJsCode,
} from '../workflows/escalation-resolver.mjs';

const rootDir = join(import.meta.dirname, '..');

function runResolver(runtime, category, rewardSource = '') {
  const coreMatch = escalationResolverNodeJsCode().match(
    /^([\s\S]*?)const runtime = \$\('Load Bot Config'\)/,
  );
  const core = coreMatch?.[1] || '';
  const fn = new Function(
    'runtime',
    'category',
    'rewardSource',
    `${core}
return resolveEscalation(runtime, category, rewardSource);`,
  );
  return fn(runtime, category, rewardSource);
}

test('escalation resolver returns required_fields from bot_config templates', () => {
  const runtime = {
    escalationRequirements: {
      withdrawal: {
        items: [
          { name: 'paypal_email', label: 'PayPal email', type: 'email' },
          { name: 'amount', label: 'Amount', type: 'text' },
        ],
      },
      tournament: {
        items: [{ name: 'tournament_id', label: 'Tournament ID', type: 'text' }],
      },
    },
  };

  const withdrawal = runResolver(runtime, 'withdrawal');
  assert.equal(withdrawal.category, 'withdrawal');
  assert.deepEqual(withdrawal.required_fields, ['paypal_email', 'amount']);
  assert.equal(withdrawal.source, 'bot_config');

  const reward = runResolver(runtime, 'reward', 'tournament');
  assert.equal(reward.category, 'reward');
  assert.equal(reward.reward_source, 'tournament');
  assert.deepEqual(reward.required_fields, ['tournament_id']);
});

test('escalation resolver returns empty requirements when bot_config is missing', () => {
  const result = runResolver({}, 'account');
  assert.equal(result.category, 'account');
  assert.deepEqual(result.required_fields, []);
  assert.equal(result.source, 'bot_config_empty');
});

test('main workflow template no longer references escalation sub-workflow', () => {
  const workflow = readFileSync(
    join(rootDir, 'workflows/progolf-support-bot-v2-pgvector.json'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /YD4d0AAkcvOSSLua/);
  assert.doesNotMatch(workflow, /toolWorkflow/);
  assert.match(workflow, /toolCode/);
  assert.match(escalationResolverToolJsCode('helio_bot_config_99'), /getWorkflowStaticData/);
});
