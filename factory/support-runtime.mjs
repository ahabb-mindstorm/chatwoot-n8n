import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shared support runtime revision for new Helio provisions. */
export const RUNTIME_REVISION = 'helio-support-runtime-v1';

const AGENT_NODE_NAMES = new Set([
  'Support Agent',
  'OpenAI Model',
  'Embeddings OpenAI',
  'Get Escalation Requirements',
  'Agent Output Parser',
  'Output Fixer Model',
  'Merge QA With Routing Decision',
  'Route Requirement Lookup',
  'Send Reply',
  'Normalize Escalation Lookup',
  'Load Canonical Escalation Requirements',
  'Reconcile Handoff Requirements',
  'Route Action',
  'Build Escalation Form',
  'Save Escalation Context',
  'Route Saved Escalation',
  'Send Escalation Form',
  'Prepare Handoff',
  'Post Internal Note',
  'Label Conversation',
  'Notify Player',
  'Open Conversation',
  'Postgres Chat Memory',
  'Code in JavaScript',
  'Search FAQ Knowledge Base',
  'Finalize Batch',
  'Claim Save Escalation Context',
  'Run Save Escalation Context?',
  'Complete Save Escalation Context',
  'Claim Send Reply',
  'Run Send Reply?',
  'Complete Send Reply',
  'Claim Send Escalation Form',
  'Run Send Escalation Form?',
  'Complete Send Escalation Form',
  'Claim Post Internal Note',
  'Run Post Internal Note?',
  'Complete Post Internal Note',
  'Claim Label Conversation',
  'Run Label Conversation?',
  'Complete Label Conversation',
  'Claim Notify Player',
  'Run Notify Player?',
  'Complete Notify Player',
  'Claim Open Conversation',
  'Run Open Conversation?',
  'Complete Open Conversation',
  'Load Bot Config',
  'Sticky Note e1bc1a27',
]);

const SHARED_RUNTIME_DROP = new Set([
  'Verify Chatwoot Webhook',
  'Webhook Authorized?',
  'Respond Authorized',
  'Restore Verified Webhook',
  'Reject Unauthorized',
  'Extract Event',
  'Eligible Durable Event?',
  'Prepare Durable Event',
  'Ingest Durable Event',
  'Accepted Durable Event?',
  'Wait For Debounce',
  'Load Agent Bot Switch',
  'Agent Bot Enabled?',
  'Suppress Disabled Event',
  'Claim Debounced Batch',
  'Normalize Claimed Batch',
  'Has Claimed Batch?',
  'Route Event',
  'Typing Indicators Enabled?',
  'Wait Before Typing',
  'Typing On',
  'Typing Off Before Reply',
  'Typing Off Before Form',
  'Typing Off Before Notify',
  'Recovery Schedule',
  'Load Recovery Switch',
  'Recovery Enabled?',
  'Recover Next Batch',
  'Cleanup Schedule',
  'Cleanup Idempotency Records',
]);

export function supportRuntimeWorkflowName(revision = RUNTIME_REVISION) {
  return `Helio Support Runtime (${revision})`;
}

export function supportRuntimeWebhookPath(revision = RUNTIME_REVISION) {
  return `helio-support-runtime-${revision}`;
}

export function ingressWorkflowName(spec) {
  return `Helio ${spec.gameId} Ingress - account ${spec.accountId} inbox ${spec.inboxId}`;
}

export function renderIngressWorkflow(template, spec, options) {
  const workflow = cloneWithoutN8nIdentity(template);
  workflow.name = ingressWorkflowName(spec);
  workflow.meta = {
    helioProvisioned: true,
    helioKind: 'ingress',
    gameId: spec.gameId,
    accountId: spec.accountId,
    inboxId: spec.inboxId,
    agentBotId: spec.bot.id,
    runtimeRevision: RUNTIME_REVISION,
    portalSlug: spec.portalSlug || null,
  };

  workflow.nodes = workflow.nodes.filter((node) => !AGENT_NODE_NAMES.has(node.name));
  pruneConnections(workflow);

  const configUrl =
    spec.bot.configUrl || `/api/v1/accounts/${spec.accountId}/agent-bots/${spec.bot.id}/config`;
  const invokeNode = {
    parameters: {
      method: 'POST',
      url: options.supportRuntimeWebhookUrl,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ agentBotId: ${spec.bot.id}, accountId: ${spec.accountId}, inboxId: ${spec.inboxId}, gameId: ${JSON.stringify(spec.gameId)}, accessToken: ${JSON.stringify(spec.bot.accessToken)}, webhookSecret: ${JSON.stringify(spec.bot.webhookSecret)}, helioBaseUrl: ${JSON.stringify(spec.helioBaseUrl || '')}, configUrl: ${JSON.stringify(configUrl)}, ragTableName: ${JSON.stringify(ragTableName(spec))}, memoryTableName: ${JSON.stringify(memoryTableName(spec))}, memorySessionPrefix: ${JSON.stringify(memorySessionPrefix(spec))}, systemMessage: ${JSON.stringify(spec.systemMessage || '')}, claimedBatch: $json }) }}`,
      options: { timeout: 120000 },
    },
    id: deterministicId(`ingress-invoke-${spec.bot.id}`, 'http'),
    name: 'Invoke Support Runtime',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [4200, 300],
  };
  workflow.nodes.push(invokeNode);

  if (workflow.connections['Restore Debounced Context']?.main?.[0]?.[0]) {
    workflow.connections['Restore Debounced Context'].main[0][0].node = 'Invoke Support Runtime';
  }
  workflow.connections['Invoke Support Runtime'] = { main: [[]] };

  sanitizeProGolfVocabulary(workflow);
  return workflow;
}

export function renderSharedSupportRuntime(template, options = {}) {
  const revision = options.revision || RUNTIME_REVISION;
  const workflow = cloneWithoutN8nIdentity(template);
  workflow.name = supportRuntimeWorkflowName(revision);
  workflow.meta = {
    helioKind: 'supportRuntime',
    helioProvisioned: true,
    runtimeRevision: revision,
    templateId: 'helio-support-runtime',
  };

  workflow.nodes = workflow.nodes.filter((node) => !SHARED_RUNTIME_DROP.has(node.name));
  pruneConnections(workflow);

  const path = supportRuntimeWebhookPath(revision);
  const webhook = workflow.nodes.find((node) => node.name === 'Chatwoot Bot Events');
  if (webhook) {
    webhook.name = 'Support Runtime Webhook';
    webhook.parameters = {
      httpMethod: 'POST',
      path,
      responseMode: 'onReceived',
      options: {},
    };
    webhook.webhookId = path;
    webhook.notesInFlow = true;
    webhook.notes = `Ingress workflows POST claimed batches here: ${webhookUrl(options.webhookBaseUrl, path)}`;
  }

  workflow.nodes.push({
    parameters: { mode: 'runOnceForEachItem', jsCode: acceptRuntimePayloadJs() },
    id: deterministicId(path, 'accept'),
    name: 'Accept Runtime Payload',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [400, 300],
  });

  workflow.connections['Support Runtime Webhook'] = {
    main: [[{ node: 'Accept Runtime Payload', type: 'main', index: 0 }]],
  };
  delete workflow.connections['Chatwoot Bot Events'];

  injectRuntimeLoadBotConfig(workflow);
  patchRuntimeSupportAgent(workflow);
  patchRuntimeFaqAndMemory(workflow);
  sanitizeProGolfVocabulary(workflow);

  workflow.connections['Accept Runtime Payload'] = {
    main: [[{ node: 'Load Bot Config', type: 'main', index: 0 }]],
  };
  workflow.connections['Load Bot Config'] = {
    main: [[{ node: 'Support Agent', type: 'main', index: 0 }]],
  };

  return workflow;
}

function acceptRuntimePayloadJs() {
  return `const raw = $input.item?.json || {};
const body = raw.body && typeof raw.body === 'object' ? raw.body : raw;
const claimed = body.claimedBatch && typeof body.claimedBatch === 'object' ? body.claimedBatch : {};
const agentBotId = Number(body.agentBotId);
const accessToken = String(body.accessToken || '').trim();
const ragTableName = String(body.ragTableName || '').trim();
if (!Number.isInteger(agentBotId) || !accessToken || !ragTableName) {
  throw new Error('agentBotId, accessToken, and ragTableName are required');
}
return {
  json: {
    ...claimed,
    helioRuntime: {
      agentBotId,
      accountId: Number(body.accountId) || claimed.accountId || null,
      inboxId: Number(body.inboxId) || claimed.inboxId || null,
      gameId: String(body.gameId || ''),
      accessToken,
      webhookSecret: String(body.webhookSecret || ''),
      helioBaseUrl: String(body.helioBaseUrl || ''),
      configUrl: String(body.configUrl || ''),
      ragTableName,
      memoryTableName: String(body.memoryTableName || ''),
      memorySessionPrefix: String(body.memorySessionPrefix || ''),
      systemMessage: String(body.systemMessage || ''),
      runtimeRevision: ${JSON.stringify(RUNTIME_REVISION)},
    },
  },
};`;
}

function injectRuntimeLoadBotConfig(workflow) {
  const runtimeContract = loadRuntimeContractText();
  const loadNode = {
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const item = $input.item?.json || {};
const runtime = item.helioRuntime || {};
const staticData = $getWorkflowStaticData('global');
const cacheKey = 'helio_bot_config_' + String(runtime.agentBotId || 'unknown');
const now = Date.now();
const ttlMs = 30 * 1000;
const runtimeContract = ${JSON.stringify(runtimeContract)};
let cached = staticData[cacheKey];

async function loadConfig() {
  const response = await this.helpers.httpRequest({
    method: 'GET',
    url: runtime.configUrl,
    headers: { 'api-access-token': runtime.accessToken },
    json: true,
    timeout: 8000,
  });
  const config = response && typeof response === 'object' ? response : {};
  staticData[cacheKey] = { expiresAt: now + ttlMs, configVersion: config.configVersion || 0, config };
  return config;
}

if (!cached || !cached.expiresAt || cached.expiresAt <= now) {
  cached = { config: await loadConfig() };
}

const config = cached.config || {};
const botConfig = config.botConfig && typeof config.botConfig === 'object' ? config.botConfig : {};
const gameInstructions = config.systemMessage || botConfig.systemMessage || runtime.systemMessage || '';
const instructions = String(gameInstructions || '').trim();
const contract = String(runtimeContract || '').trim();
const composed = contract && instructions
  ? contract + '\\n\\n## Game instructions\\n' + instructions
  : (contract || instructions || null);

return {
  json: {
    ...item,
    botRuntimeConfig: botConfig,
    botSystemMessage: composed,
    botConfigVersion: config.configVersion || cached.configVersion || 0,
    botConfigCacheTtlSeconds: 30,
    runtimeRevision: runtime.runtimeRevision || ${JSON.stringify(RUNTIME_REVISION)},
  },
};`,
    },
    id: deterministicId('shared-runtime-load-config', 'load'),
    name: 'Load Bot Config',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [700, 300],
  };

  workflow.nodes = workflow.nodes.filter((node) => node.name !== 'Load Bot Config');
  workflow.nodes.push(loadNode);
}

function patchRuntimeSupportAgent(workflow) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Support Agent');
  if (!node) return;
  node.parameters = node.parameters || {};
  node.parameters.options = {
    ...(node.parameters.options || {}),
    systemMessage: "={{ $('Load Bot Config').first().json.botSystemMessage }}",
  };
}

function patchRuntimeFaqAndMemory(workflow) {
  const faq = workflow.nodes.find((node) => node.name === 'Search FAQ Knowledge Base');
  if (faq) {
    faq.parameters = {
      ...(faq.parameters || {}),
      tableName: "={{ $('Accept Runtime Payload').first().json.helioRuntime.ragTableName }}",
      toolDescription:
        "Searches this game's official FAQ knowledge base for grounded support answers. Use before answering how-to or troubleshooting questions.",
    };
  }

  const memory = workflow.nodes.find((node) => node.name === 'Postgres Chat Memory');
  if (memory) {
    memory.parameters = {
      ...(memory.parameters || {}),
      tableName: "={{ $('Accept Runtime Payload').first().json.helioRuntime.memoryTableName }}",
      sessionKey:
        "={{ $('Accept Runtime Payload').first().json.helioRuntime.memorySessionPrefix + String($json.accountId || $('Accept Runtime Payload').first().json.accountId || '') + ':' + String($json.conversationId || $('Accept Runtime Payload').first().json.conversationId || '') }}",
    };
  }
}

export function sanitizeProGolfVocabulary(workflow) {
  const serialized = JSON.stringify(workflow);
  const cleaned = serialized
    .replace(/Pro Golf: Real Cash/gi, 'this game')
    .replace(/Pro Golf/gi, 'this game')
    .replace(/Pro Caddy/gi, 'support assistant')
    .replace(/progolf_support_agent_memory/gi, 'helio_bot_memory')
    .replace(/progolf_support_json_v2:/gi, 'helio_session:')
    .replace(/progolf_faq_vectors/gi, 'faq_vectors')
    .replace(/golf_pass/gi, 'reward_pass')
    .replace(/topshot/gi, 'special_event')
    .replace(/loot_bag/gi, 'loot_reward')
    .replace(/Mindstorm Studios/gi, 'the studio')
    .replace(/official Pro Golf FAQ/gi, "this game's official FAQ");
  const parsed = JSON.parse(cleaned);
  workflow.nodes = parsed.nodes;
  workflow.connections = parsed.connections;
  workflow.name = parsed.name;
  workflow.meta = parsed.meta;
  return workflow;
}

function pruneConnections(workflow) {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const next = {};
  for (const [from, conn] of Object.entries(workflow.connections || {})) {
    if (!names.has(from)) continue;
    const cloned = JSON.parse(JSON.stringify(conn));
    for (const [channel, outputs] of Object.entries(cloned)) {
      if (!Array.isArray(outputs)) continue;
      cloned[channel] = outputs.map((branch) =>
        Array.isArray(branch) ? branch.filter((edge) => edge && names.has(edge.node)) : branch,
      );
    }
    next[from] = cloned;
  }
  workflow.connections = next;
}

function cloneWithoutN8nIdentity(template) {
  const clone = JSON.parse(JSON.stringify(template));
  delete clone.id;
  delete clone.active;
  delete clone.versionId;
  delete clone.createdAt;
  delete clone.updatedAt;
  delete clone.shared;
  return clone;
}

function loadRuntimeContractText() {
  try {
    return readFileSync(join(repoRoot, 'factory', 'runtime-contract.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function identifierPart(...parts) {
  return parts
    .map((part) => String(part).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('_');
}

function ragTableName(spec) {
  return `bot_rag.${identifierPart('faq', spec.gameId, spec.accountId, spec.inboxId, spec.bot.id)}`;
}

function memoryTableName(spec) {
  return identifierPart('helio_bot_memory', spec.bot.id);
}

function memorySessionPrefix(spec) {
  return `${identifierPart('helio', spec.gameId, spec.bot.id)}:`;
}

function webhookUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/$/, '')}/webhook/${path}`;
}

function deterministicId(path, suffix) {
  const hash = crypto.createHash('sha1').update(`${path}:${suffix}`).digest('hex');
  return hash.slice(0, 16);
}
