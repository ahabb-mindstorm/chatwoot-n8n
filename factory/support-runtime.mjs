import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildN8nSupportRuntimeAdapterSource } from '../runtime/n8n-support-runtime-adapter.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeArtifactPath = join(
  repoRoot,
  'factory',
  'artifacts',
  'helio-support-runtime.json',
);
const runtimeRevisionRegistryPath = join(
  repoRoot,
  'factory',
  'artifacts',
  'runtime-revisions.json',
);

/** Shared support runtime revision for new Helio provisions. */
export const RUNTIME_REVISION = 'helio-support-runtime-v14';

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

const LEGACY_RUNTIME_EFFECT_NODES = new Set([
  'Get Escalation Requirements',
  'Sticky Note e1bc1a27',
  'Restore Debounced Context',
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
  'Code in JavaScript',
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
]);

/** Schedules/recovery only — ingress must keep verify/ingest/respond nodes. */
const INGRESS_SCHEDULE_DROP = new Set([
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
  workflow.nodes = workflow.nodes.filter((node) => !INGRESS_SCHEDULE_DROP.has(node.name));
  pruneConnections(workflow);

  const helioBaseUrl =
    spec.helioBaseUrl ||
    process.env.HELIO_BASE_URL ||
    process.env.CHATWOOT_BASE_URL ||
    'http://host.docker.internal:3000';
  const configUrl = absoluteUrl(
    helioBaseUrl,
    spec.bot.configUrl || `/api/v1/accounts/${spec.accountId}/agent-bots/${spec.bot.id}/config`,
  );
  const invokeNode = {
    parameters: {
      method: 'POST',
      url: options.supportRuntimeWebhookUrl,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'x-helio-runtime-secret',
            value: '={{ $env.BOT_FACTORY_API_SECRET }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ agentBotId: ${spec.bot.id}, accountId: ${spec.accountId}, inboxId: ${spec.inboxId}, gameId: ${JSON.stringify(spec.gameId)}, accessToken: ${JSON.stringify(spec.bot.accessToken)}, webhookSecret: ${JSON.stringify(spec.bot.webhookSecret)}, helioBaseUrl: ${JSON.stringify(helioBaseUrl)}, configUrl: ${JSON.stringify(configUrl)}, ragTableName: ${JSON.stringify(ragTableName(spec))}, memoryTableName: ${JSON.stringify(memoryTableName(spec))}, memorySessionPrefix: ${JSON.stringify(memorySessionPrefix(spec))}, systemMessage: ${JSON.stringify(spec.systemMessage || '')}, claimedBatch: $json }) }}`,
      options: { timeout: 120000 },
    },
    id: deterministicId(`ingress-invoke-${spec.bot.id}`, 'http'),
    name: 'Invoke Support Runtime',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [4200, 300],
  };
  workflow.nodes.push(invokeNode);

  workflow.connections['Restore Debounced Context'] = {
    main: [[{ node: 'Invoke Support Runtime', type: 'main', index: 0 }]],
  };
  workflow.connections['Invoke Support Runtime'] = { main: [[]] };
  if (workflow.nodes.some((node) => node.name === 'Has Claimed Batch?')) {
    workflow.connections['Has Claimed Batch?'] = {
      main: [
        [{ node: 'Invoke Support Runtime', type: 'main', index: 0 }],
        [],
      ],
    };
  }

  sanitizeProGolfVocabulary(workflow);
  return workflow;
}

export function renderSharedSupportRuntime(_template, options = {}) {
  const revision = options.revision || RUNTIME_REVISION;
  const artifactSource = readFileSync(runtimeArtifactPath, 'utf8');
  const artifact = JSON.parse(artifactSource);
  const revisionRegistry = JSON.parse(
    readFileSync(runtimeRevisionRegistryPath, 'utf8'),
  );
  if (artifact?.meta?.runtimeRevision !== revision) {
    throw new Error(
      `Support runtime artifact revision ${artifact?.meta?.runtimeRevision || 'missing'} does not match ${revision}`,
    );
  }
  const expectedDigest = String(revisionRegistry[revision] || '');
  const actualDigest = crypto
    .createHash('sha256')
    .update(artifactSource)
    .digest('hex');
  if (!expectedDigest || actualDigest !== expectedDigest) {
    throw new Error(`Support runtime artifact digest mismatch for ${revision}`);
  }
  const workflow = cloneWithoutN8nIdentity(artifact);
  const webhook = workflow.nodes.find(
    (node) => node.name === 'Support Runtime Webhook',
  );
  if (webhook) {
    webhook.notes = `Ingress workflows POST claimed batches here: ${webhookUrl(
      options.webhookBaseUrl,
      supportRuntimeWebhookPath(revision),
    )}`;
  }
  return workflow;
}

/** Refresh the owned generic artifact with current runtime code and contract. */
export function buildSharedSupportRuntimeArtifact(template, options = {}) {
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
  workflow.nodes = workflow.nodes.filter(
    (node) => !LEGACY_RUNTIME_EFFECT_NODES.has(node.name),
  );
  pruneConnections(workflow);
  rewireSharedRuntimeAfterTypingDrop(workflow);

  const path = supportRuntimeWebhookPath(revision);
  const webhook = workflow.nodes.find(
    (node) =>
      node.name === 'Chatwoot Bot Events' ||
      node.name === 'Support Runtime Webhook',
  );
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

  workflow.nodes = workflow.nodes.filter(
    (node) => node.name !== 'Accept Runtime Payload',
  );
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
  injectRuntimeTicketState(workflow);
  injectRuntimeTurnRouter(workflow);
  patchRuntimeSupportAgent(workflow);
  patchRuntimeFaqAndMemory(workflow);
  patchRuntimeTaxonomyNodes(workflow);
  patchRuntimeAuthorizationBoundary(workflow);
  patchRuntimeOutboundReferences(workflow);
  sanitizeProGolfVocabulary(workflow);

  workflow.connections['Accept Runtime Payload'] = {
    main: [[{ node: 'Load Bot Config', type: 'main', index: 0 }]],
  };
  workflow.connections['Load Bot Config'] = {
    main: [[{ node: 'Load Ticket State', type: 'main', index: 0 }]],
  };
  workflow.connections['Load Ticket State'] = {
    main: [[{ node: 'Merge Ticket State', type: 'main', index: 0 }]],
  };
  workflow.connections['Merge Ticket State'] = {
    main: [[{ node: 'Route Runtime Turn', type: 'main', index: 0 }]],
  };
  workflow.connections['Route Runtime Turn'] = {
    main: [
      [{ node: 'Support Agent', type: 'main', index: 0 }],
      [{ node: 'Merge QA With Routing Decision', type: 'main', index: 0 }],
      [{ node: 'Merge QA With Routing Decision', type: 'main', index: 0 }],
    ],
  };
  workflow.connections['Support Agent'] = {
    main: [
      [{ node: 'Merge QA With Routing Decision', type: 'main', index: 0 }],
      [{ node: 'Merge QA With Routing Decision', type: 'main', index: 0 }],
    ],
  };
  workflow.connections['Merge QA With Routing Decision'] = {
    main: [[{ node: 'Finalize Batch', type: 'main', index: 0 }]],
  };
  return workflow;
}

function acceptRuntimePayloadJs() {
  return `const raw = $input.item?.json || {};
const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : {};
const expectedSecret = String($env.BOT_FACTORY_API_SECRET || '').trim();
const providedSecret = String(
  headers['x-helio-runtime-secret'] || headers['X-Helio-Runtime-Secret'] || '',
).trim();
if (!expectedSecret || providedSecret !== expectedSecret) {
  throw new Error('Unauthorized support runtime invocation');
}
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

function resolveConfigUrl() {
  const url = String(runtime.configUrl || '').trim();
  if (/^https?:\\/\\//i.test(url)) return url;
  const base = String(runtime.helioBaseUrl || '').replace(/\\/$/, '');
  if (!base) {
    throw new Error('helioBaseUrl or absolute configUrl is required to load bot config');
  }
  return base + '/' + url.replace(/^\\//, '');
}

async function loadConfig() {
  const response = await this.helpers.httpRequest({
    method: 'GET',
    url: resolveConfigUrl(),
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
const policyContext = JSON.stringify({
  taxonomy: botConfig.taxonomy || {},
  escalationRequirements:
    botConfig.escalationRequirements || botConfig.escalation_requirements || {},
});
const baseInstructions = contract && instructions
  ? contract + '\\n\\n## Game instructions\\n' + instructions
  : (contract || instructions || null);
const composed = String(baseInstructions || '') +
  '\\n\\n## Published bot policy\\n' + policyContext;

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

function injectRuntimeTicketState(workflow) {
  const postgresCreds = { postgres: { id: 'botPgNeonLocal01', name: 'Bot Postgres' } };

  const loadNode = {
    parameters: {
      operation: 'executeQuery',
      query: `={{ "SELECT * FROM bot_load_ticket_state(" + Number($('Accept Runtime Payload').first().json.accountId || $('Accept Runtime Payload').first().json.helioRuntime.accountId) + ", " + Number($('Accept Runtime Payload').first().json.conversationId) + ", " + Number($('Accept Runtime Payload').first().json.helioRuntime.agentBotId) + ");" }}`,
      options: { queryBatching: 'single' },
    },
    id: deterministicId('shared-runtime-load-ticket-state', 'pg'),
    name: 'Load Ticket State',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [860, 300],
    credentials: postgresCreds,
  };

  const mergeNode = {
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const prior = $('Load Bot Config').first().json || {};
const loaded = $input.item?.json || {};
const ticketState = {
  found: Boolean(loaded.found),
  phase: String(loaded.phase || 'idle'),
  botStatus: String(loaded.bot_status || loaded.botStatus || 'idle'),
  caseType: loaded.case_type || loaded.caseType || null,
  lastIntent: loaded.last_intent || loaded.lastIntent || null,
  supportState: loaded.support_state || loaded.supportState || {},
  supportStateVersion: Number(loaded.support_state_version || loaded.supportStateVersion || 1),
  clarificationPending: Boolean(loaded.clarification_pending || loaded.clarificationPending),
  lastMessageId: loaded.last_message_id || loaded.lastMessageId || null,
  updatedAt: loaded.updated_at || loaded.updatedAt || null,
};
return { json: { ...prior, ticketState } };`,
    },
    id: deterministicId('shared-runtime-merge-ticket-state', 'code'),
    name: 'Merge Ticket State',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1020, 300],
  };

  const drop = new Set([
    'Load Ticket State',
    'Merge Ticket State',
    'Prepare Ticket State Persist',
    'Persist Ticket State',
  ]);
  workflow.nodes = workflow.nodes.filter((node) => !drop.has(node.name));
  workflow.nodes.push(loadNode, mergeNode);
}

function injectRuntimeTurnRouter(workflow) {
  const stringCondition = (leftValue, rightValue, operation, id) => ({
    leftValue,
    rightValue,
    operator: { type: 'string', operation },
    id: deterministicId(`shared-runtime-route-${id}`, 'condition'),
  });
  const routableCondition = (route, id) => ({
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 3,
      },
      conditions: [
        stringCondition('={{ $json.route }}', route, 'equals', `${id}-route`),
        stringCondition(
          '={{ $json.ticketState.phase }}',
          'human_owned',
          'notEquals',
          `${id}-phase`,
        ),
        stringCondition(
          '={{ $json.ticketState.botStatus }}',
          'human_owned',
          'notEquals',
          `${id}-status`,
        ),
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey: id,
  });
  const humanOwnedCondition = {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 3,
      },
      conditions: [
        stringCondition(
          '={{ $json.ticketState.phase }}',
          'human_owned',
          'equals',
          'human-owned-phase',
        ),
        stringCondition(
          '={{ $json.ticketState.botStatus }}',
          'human_owned',
          'equals',
          'human-owned-status',
        ),
      ],
      combinator: 'or',
    },
    renameOutput: true,
    outputKey: 'Human Owned',
  };
  const node = {
    parameters: {
      rules: {
        values: [
          routableCondition('user_message', 'Player Message'),
          routableCondition('form_submitted', 'Form Submitted'),
          humanOwnedCondition,
        ],
      },
      options: {},
    },
    id: deterministicId('shared-runtime-route-turn', 'switch'),
    name: 'Route Runtime Turn',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.4,
    position: [1160, 300],
  };
  workflow.nodes = workflow.nodes.filter(
    (candidate) => candidate.name !== 'Route Runtime Turn',
  );
  workflow.nodes.push(node);
}

function patchRuntimeSupportAgent(workflow) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Support Agent');
  if (!node) return;
  node.parameters = node.parameters || {};
  node.parameters.options = {
    ...(node.parameters.options || {}),
    systemMessage: "={{ $('Load Bot Config').first().json.botSystemMessage }}",
    returnIntermediateSteps: true,
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

/** Replace ProGolf-baked taxonomy heuristics with live botConfig-driven logic. */
function patchRuntimeTaxonomyNodes(workflow) {
  const normalize = workflow.nodes.find((node) => node.name === 'Normalize Escalation Lookup');
  if (normalize) {
    normalize.parameters = {
      ...(normalize.parameters || {}),
      jsCode: policyDrivenNormalizeEscalationJs(),
    };
  }

  const form = workflow.nodes.find((node) => node.name === 'Build Escalation Form');
  if (form?.parameters?.jsCode) {
    form.parameters.jsCode = policyDrivenBuildEscalationFormJs(form.parameters.jsCode);
  }

  const parser = workflow.nodes.find((node) => node.name === 'Agent Output Parser');
  if (parser?.parameters?.inputSchema) {
    try {
      const schema = JSON.parse(parser.parameters.inputSchema);
      if (schema.properties?.category) {
        delete schema.properties.category.enum;
        schema.properties.category.description =
          'Support category slug from this bot\'s published taxonomy. Use other when unclear.';
      }
      if (schema.properties?.reward_source) {
        delete schema.properties.reward_source.enum;
        schema.properties.reward_source.description =
          'Reward source slug from this bot\'s published taxonomy when category is reward. Empty otherwise. Use unknown if unclear.';
      }
      if (schema.properties?.action) {
        schema.properties.action.enum = [
          'reply',
          'clarify',
          'self_serve',
          'escalate',
          'handoff',
        ];
        schema.properties.action.description =
          'Use reply only for non-factual greetings, closings, or scope redirects; clarify for a focused question; self_serve for every factual FAQ-grounded answer; escalate for a form; handoff for an authorized direct human transfer.';
      }
      if (schema.properties?.reply) {
        schema.properties.reply.description =
          'Plain-text message shown to the player. Do not use Markdown, repeat answered questions, or mention retrieval internals. Redirect unrelated questions to this game\'s support topics. Every factual claim, troubleshooting step, or optimization claim must be directly supported by exact current-turn FAQ evidence; do not infer effects or outcomes that are not explicit in that evidence.';
      }
      schema.properties.faq_evidence_ids = {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact document ids from Search FAQ Knowledge Base used by a self_serve reply. Empty for every other action.',
      };
      schema.properties.grounding_quotes = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            evidence_id: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['evidence_id', 'quote'],
          additionalProperties: false,
        },
        description:
          'Direct quotes copied from current-turn FAQ documents. Every self_serve sentence must contain at least one quote. Empty for every other action.',
      };
      schema.required = [
        'action',
        'reply',
        'category',
        'summary',
        'reward_source',
        'collected_fields',
        'handoff_override_reason',
        'faq_evidence_ids',
        'grounding_quotes',
      ];
      schema.additionalProperties = false;
      parser.parameters.inputSchema = JSON.stringify(schema, null, 2);
    } catch {
      // Keep template schema if unparsable.
    }
  }
}

function patchRuntimeAuthorizationBoundary(workflow) {
  const node = workflow.nodes.find(
    (candidate) => candidate.name === 'Merge QA With Routing Decision',
  );
  if (!node) return;
  const moduleSource = readFileSync(
    join(repoRoot, 'runtime', 'support-runtime.mjs'),
    'utf8',
  );
  node.parameters = {
    mode: 'runOnceForAllItems',
    jsCode: buildN8nSupportRuntimeAdapterSource(moduleSource),
  };
  node.notesInFlow = true;
  node.notes =
    'Authorization boundary: SupportRuntime validates current-turn FAQ evidence, escalation policy, ticket state, and handoff rules before legacy effect nodes execute.';
}

function patchRuntimeIgnoredOutcome(workflow) {
  const route = workflow.nodes.find(
    (candidate) => candidate.name === 'Route Requirement Lookup',
  );
  const values = route?.parameters?.rules?.values;
  if (!Array.isArray(values)) return;
  const ignoredOutputIndex = values.length;
  values.push({
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      combinator: 'and',
      conditions: [
        {
          leftValue: '={{ $json.output.action }}',
          rightValue: 'ignored',
          operator: { type: 'string', operation: 'equals' },
          id: deterministicId('shared-runtime-ignore-outcome', 'condition'),
        },
      ],
    },
    renameOutput: true,
    outputKey: 'Ignored',
  });
  if (!workflow.connections['Route Requirement Lookup']) {
    workflow.connections['Route Requirement Lookup'] = { main: [] };
  }
  const main = workflow.connections['Route Requirement Lookup'].main || [];
  while (main.length <= ignoredOutputIndex) main.push([]);
  main[ignoredOutputIndex] = [
    { node: 'Finalize Batch', type: 'main', index: 0 },
  ];
  workflow.connections['Route Requirement Lookup'].main = main;
}

/** Replace ingress-only node/$env refs with Accept Runtime Payload / helioRuntime. */
function patchRuntimeOutboundReferences(workflow) {
  const replacements = [
    ["$('Normalize Claimed Batch')", "$('Accept Runtime Payload')"],
    ['$("Normalize Claimed Batch")', '$("Accept Runtime Payload")'],
    [
      '$env.CHATWOOT_BASE_URL',
      "$('Accept Runtime Payload').first().json.helioRuntime.helioBaseUrl",
    ],
    [
      '$env.CHATWOOT_AGENT_BOT_ACCESS_TOKEN',
      "$('Accept Runtime Payload').first().json.helioRuntime.accessToken",
    ],
    [
      '$env.CHATWOOT_API_ACCESS_TOKEN',
      "$('Accept Runtime Payload').first().json.helioRuntime.accessToken",
    ],
    [
      '$env.CHATWOOT_WEBHOOK_SECRET',
      "$('Accept Runtime Payload').first().json.helioRuntime.webhookSecret",
    ],
  ];

  const patchValue = (value) => {
    if (typeof value === 'string') {
      let next = value;
      for (const [from, to] of replacements) {
        if (next.includes(from)) next = next.split(from).join(to);
      }
      return next;
    }
    if (Array.isArray(value)) return value.map(patchValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, patchValue(child)]),
      );
    }
    return value;
  };

  workflow.nodes = workflow.nodes.map((node) => ({
    ...node,
    parameters: patchValue(node.parameters || {}),
  }));
}

function policyDrivenNormalizeEscalationJs() {
  return `function getEventContext() {
  try { return $('Accept Runtime Payload').first().json || {}; } catch (e) {}
  try { return $('Normalize Claimed Batch').first().json || {}; } catch (e) {}
  try { return $('Extract Event').first().json || {}; } catch (e) {}
  return {};
}
function getBotTaxonomy() {
  try {
    const config = $('Load Bot Config').first().json?.botRuntimeConfig || {};
    const taxonomy = config.taxonomy && typeof config.taxonomy === 'object' ? config.taxonomy : {};
    return {
      categories: Array.isArray(taxonomy.categories) ? taxonomy.categories.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean) : [],
      rewardSources: Array.isArray(taxonomy.rewardSources) ? taxonomy.rewardSources.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean) : [],
    };
  } catch (e) {
    return { categories: [], rewardSources: [] };
  }
}
const ev = getEventContext();
const item = $input.first().json;
const out = { ...(item.output || {}) };
const taxonomy = getBotTaxonomy();
const categories = taxonomy.categories.length
  ? taxonomy.categories
  : ['account', 'technical_bug', 'other', 'reward'];
const rewardSources = taxonomy.rewardSources;

function lower(value) { return String(value || '').trim().toLowerCase(); }
function combinedText() { return [ev.content, out.reply, out.summary].map(lower).join(' '); }
function includesAny(text, words) { return words.some((word) => text.includes(word)); }
function humanizeSlug(slug) {
  return String(slug || '').replace(/_/g, ' ').trim().toLowerCase();
}

let category = lower(out.category);
if (!categories.includes(category)) category = categories.includes('other') ? 'other' : (categories[0] || 'other');

const text = combinedText();
const playerReport = /\\b(cheat(er|ing)?|hacker|hack(ing|ed)?|unfair|harass(ment|ing|ed)?|abusive?|report(ing)?\\s+(a\\s+)?player|disruptive|toxic)\\b/i.test(text);
if (playerReport && categories.includes('player_report') && ['gameplay_tournament', 'other'].includes(category)) {
  category = 'player_report';
}

let rewardSource = lower(out.reward_source || out.rewardSource);
if (category === 'reward') {
  if (!rewardSources.includes(rewardSource)) {
    rewardSource = '';
    for (const source of rewardSources) {
      const label = humanizeSlug(source);
      if (!label) continue;
      if (includesAny(text, [label, source])) {
        rewardSource = source;
        break;
      }
    }
    if (!rewardSource) rewardSource = rewardSources.includes('unknown') ? 'unknown' : (rewardSources[0] ? 'unknown' : '');
  }
} else {
  rewardSource = '';
}

out.category = category;
out.reward_source = rewardSource;
return [{ json: { ...item, output: out } }];`;
}

function policyDrivenBuildEscalationFormJs(existingCode) {
  let code = String(existingCode);
  if (!code.includes('Accept Runtime Payload')) {
    code = code.replace(
      "try { return $('Normalize Claimed Batch').first().json || {}; } catch (e) {}",
      "try { return $('Accept Runtime Payload').first().json || {}; } catch (e) {}\n  try { return $('Normalize Claimed Batch').first().json || {}; } catch (e) {}",
    );
  }
  code = code.replace(/golf pass points\|?/gi, '');
  return code;
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

/**
 * Typing-off nodes are ingress-only. After they are dropped from the shared runtime,
 * rewire their former sources to the claim/send nodes they used to feed.
 */
function rewireSharedRuntimeAfterTypingDrop(workflow) {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const edge = (node) => ({ node, type: 'main', index: 0 });

  function setOutput(from, outputIndex, toNode) {
    if (!names.has(from) || !names.has(toNode)) return;
    if (!workflow.connections[from]) workflow.connections[from] = { main: [] };
    if (!Array.isArray(workflow.connections[from].main)) workflow.connections[from].main = [];
    while (workflow.connections[from].main.length <= outputIndex) {
      workflow.connections[from].main.push([]);
    }
    workflow.connections[from].main[outputIndex] = [edge(toNode)];
  }

  setOutput('Route Requirement Lookup', 0, 'Claim Send Reply');
  setOutput('Route Saved Escalation', 0, 'Claim Send Escalation Form');
  setOutput('Run Label Conversation?', 1, 'Claim Notify Player');
  setOutput('Complete Label Conversation', 0, 'Claim Notify Player');
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

function absoluteUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(baseUrl || '').replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function deterministicId(path, suffix) {
  const hash = crypto.createHash('sha1').update(`${path}:${suffix}`).digest('hex');
  return hash.slice(0, 16);
}
