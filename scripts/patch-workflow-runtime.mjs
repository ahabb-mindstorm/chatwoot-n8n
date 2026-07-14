#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMainWorkflow, validateBotSpec } from '../factory/bot-factory.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowId = process.argv[2] || 'dSYF6GahwefI6PqC';

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }),
);

const spec = validateBotSpec({
  accountId: Number(env.CHATWOOT_ACCOUNT_ID || 2),
  inboxId: Number(env.CHATWOOT_INBOX_ID || 1),
  gameId: 'progolf',
  portalSlug: 'progolf-help',
  name: 'n8n-progolf-support',
  systemMessage: null,
  botConfig: {},
  helioBaseUrl: 'http://host.docker.internal:3000',
  bot: {
    id: 1,
    accessToken: env.CHATWOOT_AGENT_BOT_ACCESS_TOKEN,
    webhookSecret: env.CHATWOOT_WEBHOOK_SECRET,
    configUrl: `/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID || 2}/agent-bots/1/config`,
  },
});

const template = JSON.parse(
  readFileSync(join(root, 'workflows/progolf-support-bot-v2-pgvector.json'), 'utf8'),
);
const rendered = renderMainWorkflow(template, spec, {
  webhookPath: 'helio-progolf-2-1-1-bot',
  webhookBaseUrl: env.WEBHOOK_URL?.replace(/\/$/, '') || 'http://localhost:5678',
});

const current = await fetch(`http://localhost:5678/api/v1/workflows/${workflowId}`, {
  headers: { 'X-N8N-API-KEY': env.N8N_API_KEY },
}).then((r) => r.json());

const patchNames = new Set([
  'Extract Event',
  'Load Bot Config',
  'Support Agent',
  'Get Escalation Requirements',
  'Load Canonical Escalation Requirements',
]);
const renderedByName = new Map(rendered.nodes.filter((n) => patchNames.has(n.name)).map((n) => [n.name, n]));

for (const node of current.nodes) {
  const patch = renderedByName.get(node.name);
  if (!patch) continue;
  node.parameters = patch.parameters;
  node.type = patch.type;
  node.typeVersion = patch.typeVersion;
  if (patch.credentials) node.credentials = patch.credentials;
  else delete node.credentials;
}

const body = {
  name: current.name,
  nodes: current.nodes,
  connections: current.connections,
  settings: { executionOrder: current.settings?.executionOrder || 'v1' },
};

const put = await fetch(`http://localhost:5678/api/v1/workflows/${workflowId}`, {
  method: 'PUT',
  headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('patch_status', put.status);
await fetch(`http://localhost:5678/api/v1/workflows/${workflowId}/activate`, {
  method: 'POST',
  headers: { 'X-N8N-API-KEY': env.N8N_API_KEY },
});
console.log('reactivated', workflowId);

const support = current.nodes.find((n) => n.name === 'Support Agent');
console.log('systemMessage', support?.parameters?.options?.systemMessage);
console.log('extract_tag', /customData\.set\('webhook'/.test(
  current.nodes.find((n) => n.name === 'Extract Event')?.parameters?.jsCode || '',
));
console.log('load_tag', /customData\.set\('ai_triggered'/.test(
  current.nodes.find((n) => n.name === 'Load Bot Config')?.parameters?.jsCode || '',
));
