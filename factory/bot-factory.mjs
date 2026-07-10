import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escalationResolverNodeJsCode,
  escalationToolNodeParameters,
} from '../workflows/escalation-resolver.mjs';
import {
  AI_TRIGGERED_EXECUTION_TAG_JS,
  WEBHOOK_EXECUTION_TAG_JS,
  prependJsSnippet,
} from '../workflows/execution-tags.mjs';
import {
  resolveProvisionTaxonomy,
} from './game-templates.mjs';
import {
  RUNTIME_REVISION,
  ingressWorkflowName,
  renderIngressWorkflow,
  renderSharedSupportRuntime,
  supportRuntimeWebhookPath,
  supportRuntimeWorkflowName,
} from './support-runtime.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_TEMPLATE_PATH = join(
  repoRoot,
  'workflows',
  'progolf-support-bot-v2-pgvector.json',
);

const DEFAULT_N8N_BASE_URL = 'http://localhost:5678';
export const SHARED_FAQ_SYNC_WORKFLOW_NAME = 'Helio FAQ Sync';
export const SHARED_FAQ_SYNC_WEBHOOK_PATH = 'helio-faq-sync';
export { RUNTIME_REVISION, renderSharedSupportRuntime };

let cachedRuntimeContract;

export function loadRuntimeContract() {
  if (cachedRuntimeContract !== undefined) return cachedRuntimeContract;
  try {
    cachedRuntimeContract = readFileSync(join(repoRoot, 'factory', 'runtime-contract.txt'), 'utf8').trim();
  } catch {
    cachedRuntimeContract = '';
  }
  return cachedRuntimeContract;
}

export function composeBotSystemMessage(gameInstructions, runtimeContract = loadRuntimeContract()) {
  const instructions = String(gameInstructions || '').trim();
  const contract = String(runtimeContract || '').trim();
  if (contract && instructions) return `${contract}\n\n## Game instructions\n${instructions}`;
  return contract || instructions || null;
}

export class FactoryError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'FactoryError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function authenticateFactoryRequest(headers, expectedSecret) {
  const configured = String(expectedSecret || '').trim();
  if (!configured) {
    throw new FactoryError(503, 'BOT_FACTORY_API_SECRET is not configured');
  }

  const provided = extractAuthSecret(headers);
  if (!provided || !timingSafeEqual(provided, configured)) {
    throw new FactoryError(401, 'Invalid Bot Factory secret');
  }
}

export function validateBotSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FactoryError(400, 'Request body must be a JSON object');
  }

  const bot = raw.bot;
  if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
    throw new FactoryError(400, 'bot must be an object');
  }

  const spec = {
    accountId: positiveInteger(raw.accountId, 'accountId'),
    inboxId: positiveInteger(raw.inboxId, 'inboxId'),
    gameId: nonEmptyString(raw.gameId, 'gameId'),
    name: optionalString(raw.name) || 'Helio Support Bot',
    portalSlug: optionalString(raw.portalSlug),
    systemMessage: optionalNullableString(raw.systemMessage),
    botConfig: raw.botConfig && typeof raw.botConfig === 'object' && !Array.isArray(raw.botConfig) ? raw.botConfig : {},
    helioBaseUrl: optionalString(raw.helioBaseUrl),
    bot: {
      id: positiveInteger(bot.id, 'bot.id'),
      accessToken: nonEmptyString(bot.accessToken, 'bot.accessToken'),
      webhookSecret: nonEmptyString(bot.webhookSecret, 'bot.webhookSecret'),
      configUrl: optionalString(bot.configUrl),
    },
  };

  return spec;
}

export async function provisionBotWorkflows(rawSpec, options = {}) {
  const spec = validateBotSpec(rawSpec);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const mainTemplate = options.mainTemplate || (await loadMainTemplate());

  const n8n = n8nConfig(env);
  const webhookBaseUrl = publicWebhookBaseUrl(env, n8n.baseUrl);
  const internalWebhookBaseUrl = internalWebhookBaseUrlFromEnv(env, webhookBaseUrl);
  const ingressPath = workflowPath('helio', spec.gameId, spec.accountId, spec.inboxId, spec.bot.id, 'bot');
  const tableName = ragTableName(spec);
  const runtimePath = supportRuntimeWebhookPath(RUNTIME_REVISION);

  const sharedRuntime = await ensureSharedSupportRuntime({
    env,
    fetchImpl,
    mainTemplate,
    webhookBaseUrl,
  });

  const ingress = renderIngressWorkflow(mainTemplate, spec, {
    webhookPath: ingressPath,
    webhookBaseUrl,
    // Ingress runs inside n8n — use the internal base so Docker localhost is not the host.
    supportRuntimeWebhookUrl: webhookUrl(internalWebhookBaseUrl, runtimePath),
  });
  patchWebhookNode(ingress, 'Chatwoot Bot Events', ingressPath, webhookBaseUrl);
  replaceEnvReferences(ingress, spec);
  patchBotTokenHeaders(ingress);
  patchExecutionTags(ingress);
  patchRecoveryScope(ingress, spec);
  patchIngestAgentBotId(ingress, spec);

  const ingressWorkflow = await upsertAndActivateWorkflow(ingress, n8n, fetchImpl);

  return {
    webhookUrl: webhookUrl(webhookBaseUrl, ingressPath),
    mainWebhookUrl: webhookUrl(webhookBaseUrl, ingressPath),
    ragTableName: tableName,
    runtimeRevision: RUNTIME_REVISION,
    supportRuntimeWebhookUrl: sharedRuntime.webhookUrl,
    supportRuntimeInternalWebhookUrl: webhookUrl(internalWebhookBaseUrl, runtimePath),
    workflowIds: {
      ingress: ingressWorkflow.id,
      supportRuntime: sharedRuntime.workflowId,
      main: ingressWorkflow.id,
    },
    ingressWorkflowId: ingressWorkflow.id,
    supportRuntimeWorkflowId: sharedRuntime.workflowId,
    mainWorkflowId: ingressWorkflow.id,
    workflowNames: {
      ingress: ingress.name,
      supportRuntime: sharedRuntime.workflowName,
      main: ingress.name,
    },
    upserted: {
      ingress: ingressWorkflow.upserted,
      supportRuntime: sharedRuntime.upserted,
      main: ingressWorkflow.upserted,
    },
  };
}

export async function ensureSharedSupportRuntime(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const n8n = n8nConfig(env);
  const webhookBaseUrl = options.webhookBaseUrl || publicWebhookBaseUrl(env, n8n.baseUrl);
  const mainTemplate = options.mainTemplate || (await loadMainTemplate());
  const rendered = renderSharedSupportRuntime(mainTemplate, {
    webhookBaseUrl,
    revision: RUNTIME_REVISION,
  });
  injectWorkflowCredentials(rendered);
  const workflow = await upsertAndActivateWorkflow(rendered, n8n, fetchImpl);
  return {
    workflowId: workflow.id,
    webhookUrl: webhookUrl(webhookBaseUrl, supportRuntimeWebhookPath(RUNTIME_REVISION)),
    workflowName: rendered.name,
    upserted: workflow.upserted,
    runtimeRevision: RUNTIME_REVISION,
  };
}

export async function ensureSharedFaqSyncWorkflow(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const n8n = n8nConfig(env);
  const webhookBaseUrl = publicWebhookBaseUrl(env, n8n.baseUrl);
  const rendered = renderSharedFaqSyncWorkflow({ webhookBaseUrl });
  const workflow = await upsertAndActivateWorkflow(rendered, n8n, fetchImpl);

  return {
    workflowId: workflow.id,
    webhookUrl: webhookUrl(webhookBaseUrl, SHARED_FAQ_SYNC_WEBHOOK_PATH),
    workflowName: rendered.name,
    upserted: workflow.upserted,
  };
}

export function validateDeprovisionSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FactoryError(400, 'Request body must be a JSON object');
  }

  const workflowIds = raw.workflowIds && typeof raw.workflowIds === 'object' && !Array.isArray(raw.workflowIds)
    ? raw.workflowIds
    : {};

  const mainWorkflowId = optionalString(raw.mainWorkflowId) || optionalString(workflowIds.main);
  const faqSyncWorkflowId = optionalString(raw.faqSyncWorkflowId) || optionalString(workflowIds.faqSync);

  const spec = {
    accountId: raw.accountId === undefined ? undefined : positiveInteger(raw.accountId, 'accountId'),
    inboxId: raw.inboxId === undefined ? undefined : positiveInteger(raw.inboxId, 'inboxId'),
    gameId: optionalString(raw.gameId),
    bot: raw.bot && typeof raw.bot === 'object' && !Array.isArray(raw.bot)
      ? { id: raw.bot.id === undefined ? undefined : positiveInteger(raw.bot.id, 'bot.id') }
      : undefined,
    workflowIds: {
      main: mainWorkflowId,
      faqSync: faqSyncWorkflowId,
    },
    mainWorkflowId,
    faqSyncWorkflowId,
  };

  const hasWorkflowIds = Boolean(spec.mainWorkflowId || spec.faqSyncWorkflowId);
  const hasLookup = Boolean(
    spec.gameId &&
    spec.accountId &&
    spec.inboxId &&
    spec.bot?.id,
  );

  if (!hasWorkflowIds && !hasLookup) {
    throw new FactoryError(
      400,
      'Provide workflowIds (main and/or faqSync) or accountId, inboxId, gameId, and bot.id for lookup',
    );
  }

  return spec;
}

export async function deprovisionBotWorkflows(rawSpec, options = {}) {
  const spec = validateDeprovisionSpec(rawSpec);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const n8n = n8nConfig(env);

  const targets = await resolveDeprovisionTargets(spec, n8n, fetchImpl);
  const deactivated = [];

  for (const workflow of targets) {
    if (!workflow.active) {
      deactivated.push({ id: workflow.id, name: workflow.name, active: false, changed: false });
      continue;
    }
    await deactivateWorkflowById(workflow.id, n8n, fetchImpl);
    deactivated.push({ id: workflow.id, name: workflow.name, active: false, changed: true });
  }

  return {
    deactivated,
    workflowIds: Object.fromEntries(
      deactivated.map((entry) => [workflowKindFromName(entry.name), entry.id]).filter(([kind]) => kind),
    ),
  };
}

export async function upsertAndActivateWorkflow(workflow, n8n, fetchImpl = fetch) {
  const matches = await findWorkflowsByExactName(workflow.name, n8n, fetchImpl);
  const target = pickWorkflowForUpsert(matches);
  const duplicates = matches.filter((candidate) => candidate.id !== target?.id);

  for (const duplicate of duplicates) {
    if (duplicate.active) {
      await deactivateWorkflowById(duplicate.id, n8n, fetchImpl);
    }
  }

  let workflowId;
  let upserted = false;
  if (target) {
    const updated = await n8nRequest(
      n8n,
      fetchImpl,
      `/api/v1/workflows/${encodeURIComponent(target.id)}`,
      {
        method: 'PUT',
        body: sanitizeWorkflowForN8nApi(workflow),
      },
    );
    workflowId = nonEmptyString(updated.id || target.id, 'updated workflow id');
    upserted = true;
  } else {
    const created = await createWorkflow(workflow, n8n, fetchImpl);
    workflowId = created.id;
  }

  await activateWorkflowById(workflowId, n8n, fetchImpl);
  return { id: workflowId, upserted };
}

export async function createAndActivateWorkflow(workflow, n8n, fetchImpl = fetch) {
  const created = await createWorkflow(workflow, n8n, fetchImpl);
  await activateWorkflowById(created.id, n8n, fetchImpl);
  return created;
}

async function createWorkflow(workflow, n8n, fetchImpl) {
  const created = await n8nRequest(
    n8n,
    fetchImpl,
    '/api/v1/workflows',
    {
      method: 'POST',
      body: sanitizeWorkflowForN8nApi(workflow),
    },
  );
  return { id: nonEmptyString(created.id, 'created workflow id') };
}

async function activateWorkflowById(workflowId, n8n, fetchImpl) {
  await n8nRequest(n8n, fetchImpl, `/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`, {
    method: 'POST',
  });
}

async function deactivateWorkflowById(workflowId, n8n, fetchImpl) {
  await n8nRequest(n8n, fetchImpl, `/api/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`, {
    method: 'POST',
  });
}

async function resolveDeprovisionTargets(spec, n8n, fetchImpl) {
  const byId = new Map();

  for (const id of [spec.mainWorkflowId, spec.ingressWorkflowId, spec.faqSyncWorkflowId]) {
    if (!id) continue;
    const workflow = await getWorkflowById(id, n8n, fetchImpl);
    byId.set(workflow.id, workflow);
  }

  if (byId.size > 0) {
    return [...byId.values()];
  }

  const names = workflowNamesForSpec({
    gameId: spec.gameId,
    accountId: spec.accountId,
    inboxId: spec.inboxId,
  });

  const targets = [];
  for (const name of names) {
    const matches = await findWorkflowsByExactName(name, n8n, fetchImpl);
    if (matches.length > 0) {
      targets.push(pickWorkflowForUpsert(matches));
    }
  }
  return targets.filter(Boolean);
}

async function getWorkflowById(workflowId, n8n, fetchImpl) {
  const workflow = await n8nRequest(
    n8n,
    fetchImpl,
    `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
  );
  return {
    id: nonEmptyString(workflow.id, 'workflow id'),
    name: String(workflow.name || ''),
    active: Boolean(workflow.active),
  };
}

async function findWorkflowsByExactName(name, n8n, fetchImpl) {
  const workflows = await listN8nWorkflows(n8n, fetchImpl);
  return workflows.filter((workflow) => workflow.name === name);
}

async function listN8nWorkflows(n8n, fetchImpl) {
  const workflows = [];
  let cursor;

  do {
    const query = new URLSearchParams({ limit: '250' });
    if (cursor) query.set('cursor', cursor);
    const response = await n8nRequest(n8n, fetchImpl, `/api/v1/workflows?${query.toString()}`);
    const batch = Array.isArray(response.data) ? response.data : [];
    for (const workflow of batch) {
      workflows.push({
        id: String(workflow.id),
        name: String(workflow.name || ''),
        active: Boolean(workflow.active),
        updatedAt: workflow.updatedAt || null,
      });
    }
    cursor = response.nextCursor || null;
  } while (cursor);

  return workflows;
}

function pickWorkflowForUpsert(matches) {
  if (!matches.length) return null;
  return [...matches].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  })[0];
}

export function workflowNamesForSpec(spec) {
  return [
    ingressWorkflowName(spec),
    `Helio ${spec.gameId} Support Bot - account ${spec.accountId} inbox ${spec.inboxId}`,
  ];
}

function workflowKindFromName(name) {
  if (name.includes('FAQ Sync')) return 'faqSync';
  if (name.includes('Support Runtime')) return 'supportRuntime';
  if (name.includes('Ingress')) return 'ingress';
  if (name.includes('Support Bot')) return 'main';
  return null;
}

export function renderMainWorkflow(template, spec, options) {
  const workflow = cloneWithoutN8nIdentity(template);
  workflow.name = `Helio ${spec.gameId} Support Bot - account ${spec.accountId} inbox ${spec.inboxId}`;
  workflow.meta = {
    ...(workflow.meta || {}),
    helioProvisioned: true,
    gameId: spec.gameId,
    accountId: spec.accountId,
    inboxId: spec.inboxId,
    agentBotId: spec.bot.id,
    portalSlug: spec.portalSlug || null,
    templateId: workflow.meta?.templateId || 'progolf-support-bot-v2-pgvector',
  };

  patchWebhookNode(workflow, 'Chatwoot Bot Events', options.webhookPath, options.webhookBaseUrl);
  replaceEnvReferences(workflow, spec);
  patchBotTokenHeaders(workflow);
  patchExecutionTags(workflow);
  injectLoadBotConfig(workflow, spec);
  patchSupportAgent(workflow);
  patchEscalationRequirements(workflow);
  patchEscalationTool(workflow, spec);
  patchFaqVectorStore(workflow, spec);
  patchChatMemory(workflow, spec);
  patchTaxonomies(workflow, spec);
  patchAgentOutputParserCopy(workflow);
  patchRecoveryScope(workflow, spec);
  patchIngestAgentBotId(workflow, spec);
  injectWorkflowCredentials(workflow);
  return workflow;
}

export function patchTaxonomies(workflow, spec) {
  const taxonomy = resolveProvisionTaxonomy(spec);
  if (!taxonomy?.categories?.length) {
    return workflow;
  }

  const categoriesLiteral = JSON.stringify(taxonomy.categories);
  const rewardSources = taxonomy.rewardSources || [];

  const normalize = workflow.nodes.find((candidate) => candidate.name === 'Normalize Escalation Lookup');
  if (normalize?.parameters?.jsCode) {
    normalize.parameters.jsCode = normalize.parameters.jsCode.replace(
      /const categories = \[[^\]]*\];/,
      `const categories = ${categoriesLiteral};`,
    );
  }

  const parser = workflow.nodes.find((candidate) => candidate.name === 'Agent Output Parser');
  if (parser?.parameters?.inputSchema) {
    try {
      const schema = JSON.parse(parser.parameters.inputSchema);
      if (schema.properties?.category) {
        schema.properties.category.enum = [...taxonomy.categories];
      }
      if (schema.properties?.reward_source) {
        schema.properties.reward_source.enum = rewardSources.length
          ? ['', ...rewardSources]
          : [''];
      }
      parser.parameters.inputSchema = JSON.stringify(schema, null, 2);
    } catch {
      // Keep the template schema if it cannot be parsed.
    }
  }

  return workflow;
}

export function renderSharedFaqSyncWorkflow(options) {
  const path = SHARED_FAQ_SYNC_WEBHOOK_PATH;
  const syncSecret =
    String(options?.syncSecret || process.env.BOT_FAQ_SYNC_SECRET || process.env.BOT_FACTORY_API_SECRET || '').trim();
  const allowedArticleUrlPrefix = String(
    options?.allowedArticleUrlPrefix ||
      process.env.HELIO_BASE_URL ||
      process.env.HELIO_API_BASE_URL ||
      process.env.CHATWOOT_BASE_URL ||
      '',
  )
    .trim()
    .replace(/\/$/, '');

  return {
    name: SHARED_FAQ_SYNC_WORKFLOW_NAME,
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path,
          responseMode: 'responseNode',
          options: {},
        },
        id: deterministicId(path, 'webhook'),
        name: 'FAQ Sync Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        webhookId: path,
        notesInFlow: true,
        notes: `Helio calls ${webhookUrl(options.webhookBaseUrl, path)} with ragTableName and bot credentials.`,
      },
      {
        parameters: {
          jsCode: sharedFaqSyncCode({ syncSecret, allowedArticleUrlPrefix }),
        },
        id: deterministicId(path, 'sync'),
        name: 'Sync Bot FAQ Chunks',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [260, 0],
        notesInFlow: true,
        notes: 'Reads Helio published articles and upserts pgvector chunks into the requested rag table.',
      },
      {
        parameters: {
          resource: 'database',
          operation: 'executeQuery',
          query: '={{ $json.query || "SELECT 1" }}',
          options: {
            queryBatching: 'single',
          },
        },
        id: deterministicId(path, 'postgres'),
        name: 'Upsert Bot FAQ Chunks',
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [520, 0],
        credentials: {
          postgres: WORKFLOW_CREDENTIALS.botPostgres,
        },
        alwaysOutputData: true,
      },
      {
        parameters: {
          jsCode: `const sync = $('Sync Bot FAQ Chunks').first().json;
return [{ json: {
  ok: sync.ok !== false,
  articles: sync.articleCount ?? 0,
  chunks: sync.chunkCount ?? 0,
  error: sync.error ?? null,
} }];`,
        },
        id: deterministicId(path, 'format'),
        name: 'Format FAQ Sync Response',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [780, 0],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {
            responseCode: 200,
          },
        },
        id: deterministicId(path, 'respond'),
        name: 'Respond FAQ Sync',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1040, 0],
      },
    ],
    connections: {
      'FAQ Sync Webhook': {
        main: [[{ node: 'Sync Bot FAQ Chunks', type: 'main', index: 0 }]],
      },
      'Sync Bot FAQ Chunks': {
        main: [[{ node: 'Upsert Bot FAQ Chunks', type: 'main', index: 0 }]],
      },
      'Upsert Bot FAQ Chunks': {
        main: [[{ node: 'Format FAQ Sync Response', type: 'main', index: 0 }]],
      },
      'Format FAQ Sync Response': {
        main: [[{ node: 'Respond FAQ Sync', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
    meta: {
      helioProvisioned: true,
      templateId: 'helio-shared-faq-sync-v1',
      shared: true,
    },
  };
}

async function loadMainTemplate() {
  return JSON.parse(await readFile(MAIN_TEMPLATE_PATH, 'utf8'));
}

function n8nConfig(env) {
  const baseUrl = String(env.N8N_BASE_URL || DEFAULT_N8N_BASE_URL).trim().replace(/\/$/, '');
  const apiKey = String(env.N8N_API_KEY || '').trim();
  if (!apiKey) {
    throw new FactoryError(503, 'N8N_API_KEY is not configured');
  }
  return { baseUrl, apiKey };
}

function publicWebhookBaseUrl(env, n8nBaseUrl) {
  return String(env.WEBHOOK_URL || env.N8N_WEBHOOK_URL || n8nBaseUrl)
    .trim()
    .replace(/\/$/, '');
}

/**
 * Base URL for n8n→n8n HTTP calls (ingress invoking support runtime).
 * Prefer an explicit internal URL, then a non-loopback N8N_BASE_URL (Compose
 * service DNS like http://n8n:5678). Fall back to 127.0.0.1 so workflows
 * running inside the n8n container do not depend on host-only WEBHOOK_URL.
 */
function internalWebhookBaseUrlFromEnv(env, _publicBaseUrl) {
  const explicit = String(env.N8N_INTERNAL_WEBHOOK_URL || env.N8N_INTERNAL_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (explicit) return explicit;

  const n8nBase = String(env.N8N_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (n8nBase && !isLoopbackHttpUrl(n8nBase)) {
    return n8nBase;
  }

  return 'http://127.0.0.1:5678';
}

function isLoopbackHttpUrl(value) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(String(value || ''));
}

async function n8nRequest(n8n, fetchImpl, path, init = {}) {
  const response = await fetchImpl(`${n8n.baseUrl}${path}`, {
    method: init.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': n8n.apiKey,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new FactoryError(502, 'n8n API request failed', {
      path,
      statusCode: response.status,
      response: body,
    });
  }
  return body;
}

function cloneWithoutN8nIdentity(template) {
  const workflow = JSON.parse(JSON.stringify(template));
  delete workflow.id;
  delete workflow.versionId;
  delete workflow.active;
  delete workflow.createdAt;
  delete workflow.updatedAt;
  delete workflow.tags;
  return workflow;
}

/** n8n Public API rejects newer template settings keys (availableInMCP, etc.). */
export function sanitizeWorkflowForN8nApi(workflow) {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: {
      executionOrder: workflow.settings?.executionOrder || 'v1',
    },
  };
}

function patchWebhookNode(workflow, nodeName, path, webhookBaseUrl) {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  if (!node) {
    throw new FactoryError(500, `${nodeName} node not found in workflow template`);
  }
  node.parameters = { ...(node.parameters || {}), path };
  node.webhookId = path;
  node.notesInFlow = true;
  node.notes = `Point Helio Agent Bot outgoing_url here: ${webhookUrl(webhookBaseUrl, path)}.`;
}

function patchSupportAgent(workflow) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Support Agent');
  if (!node) return;
  node.parameters = node.parameters || {};
  node.parameters.options = {
    ...(node.parameters.options || {}),
    systemMessage: "={{ $('Load Bot Config').first().json.botSystemMessage }}",
  };
}

function patchExecutionTags(workflow) {
  const extract = workflow.nodes.find((candidate) => candidate.name === 'Extract Event');
  if (extract?.parameters?.jsCode) {
    extract.parameters.jsCode = prependJsSnippet(extract.parameters.jsCode, WEBHOOK_EXECUTION_TAG_JS);
  }
}

function injectLoadBotConfig(workflow, spec) {
  const defaultSystemMessage = composeBotSystemMessage(
    typeof spec.systemMessage === 'string' ? spec.systemMessage : '',
  );
  const helioBaseUrl = spec.helioBaseUrl || process.env.HELIO_BASE_URL || process.env.CHATWOOT_BASE_URL || 'http://host.docker.internal:3000';
  const configUrl = absoluteUrl(helioBaseUrl, spec.bot.configUrl || `/api/v1/accounts/${spec.accountId}/agent-bots/${spec.bot.id}/config`);
  const ttlSeconds = Math.max(1, Number(spec.botConfig.configTtlSeconds || spec.botConfig.configTTLSeconds || 30));
  const runtimeContract = loadRuntimeContract();
  const loadNode = {
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `${AI_TRIGGERED_EXECUTION_TAG_JS}
const item = $input.item?.json || {};
const staticData = $getWorkflowStaticData('global');
const cacheKey = ${JSON.stringify(`helio_bot_config_${spec.bot.id}`)};
const now = Date.now();
const ttlMs = ${ttlSeconds} * 1000;
const runtimeContract = ${JSON.stringify(runtimeContract)};
let cached = staticData[cacheKey];

async function loadConfig() {
  const response = await this.helpers.httpRequest({
    method: 'GET',
    url: ${JSON.stringify(configUrl)},
    headers: { 'api-access-token': ${JSON.stringify(spec.bot.accessToken)} },
    json: true,
    timeout: 8000,
  });
  const config = response && typeof response === 'object' ? response : {};
  staticData[cacheKey] = {
    expiresAt: now + ttlMs,
    configVersion: config.configVersion || 0,
    config,
  };
  return config;
}

if (!cached || !cached.expiresAt || cached.expiresAt <= now) {
  cached = { config: await loadConfig() };
}

const config = cached.config || {};
const botConfig = config.botConfig && typeof config.botConfig === 'object' ? config.botConfig : {};
const gameInstructions = config.systemMessage || botConfig.systemMessage || ${JSON.stringify(typeof spec.systemMessage === 'string' ? spec.systemMessage : '')} || '';
const composed = (() => {
  const instructions = String(gameInstructions || '').trim();
  const contract = String(runtimeContract || '').trim();
  if (contract && instructions) return contract + '\\n\\n## Game instructions\\n' + instructions;
  return contract || instructions || null;
})();
return {
  json: {
    ...item,
    botRuntimeConfig: botConfig,
    botSystemMessage: composed || ${JSON.stringify(defaultSystemMessage)} || null,
    botConfigVersion: config.configVersion || cached.configVersion || 0,
    botConfigCacheTtlSeconds: ${ttlSeconds},
    runtimeRevision: ${JSON.stringify(RUNTIME_REVISION)},
  },
};`,
    },
    id: deterministicId(`helio-bot-config-${spec.bot.id}`, 'load'),
    name: 'Load Bot Config',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3600, 304],
    notesInFlow: true,
    notes: `Fetches Helio bot config with api-access-token. Cache TTL: ${ttlSeconds}s; cache record stores configVersion.`,
  };

  if (!workflow.nodes.some((node) => node.name === 'Load Bot Config')) {
    workflow.nodes.push(loadNode);
  }

  const restore = workflow.connections['Restore Debounced Context'];
  if (restore?.main?.[0]?.[0]?.node === 'Support Agent') {
    restore.main[0][0].node = 'Load Bot Config';
  }
  workflow.connections['Load Bot Config'] = {
    main: [[{ node: 'Support Agent', type: 'main', index: 0 }]],
  };
}

function patchEscalationRequirements(workflow) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Load Canonical Escalation Requirements');
  if (!node) return;
  node.type = 'n8n-nodes-base.code';
  node.typeVersion = 2;
  delete node.credentials;
  node.parameters = {
    mode: 'runOnceForEachItem',
    jsCode: escalationResolverNodeJsCode(),
  };
}

function patchEscalationTool(workflow, spec) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Get Escalation Requirements');
  if (!node) return;
  const cacheKey = `helio_bot_config_${spec.bot.id}`;
  node.type = '@n8n/n8n-nodes-langchain.toolCode';
  node.typeVersion = 1.2;
  delete node.credentials;
  node.parameters = escalationToolNodeParameters(cacheKey);
}

function patchBotTokenHeaders(workflow) {
  for (const node of workflow.nodes || []) {
    const params = node.parameters?.headerParameters?.parameters;
    if (!Array.isArray(params)) continue;
    for (const header of params) {
      if (header?.name === 'api_access_token') {
        header.name = 'api-access-token';
      }
    }
  }
}

function patchAgentOutputParserCopy(workflow) {
  const parser = workflow.nodes.find((candidate) => candidate.name === 'Agent Output Parser');
  if (!parser?.parameters?.inputSchema) return;

  let schemaText = String(parser.parameters.inputSchema);
  schemaText = schemaText
    .replace(/redirect to Pro Golf support only/gi, 'redirect to this game\'s support topics only')
    .replace(
      /For club\/equipment or gameplay optimization questions[^.]*\./gi,
      'For gameplay optimization questions, do not include improvement advice unless the exact causal effect appears in retrieved FAQ content.',
    )
    .replace(/\bPro Golf\b/gi, 'this game')
    .replace(/\bprogolf\b/gi, 'this game');

  parser.parameters.inputSchema = schemaText;
}

function patchRecoveryScope(workflow, spec) {
  const agentBotId = Number(spec.bot.id);
  for (const node of workflow.nodes || []) {
    const query = node.parameters?.query;
    if (typeof query !== 'string' || !query.includes('bot_recover_next_batch')) continue;

    if (query.includes(`, ${agentBotId})`) || query.includes(`, ${agentBotId});`)) {
      continue;
    }

    // Expression form: ... + ", 5);"  →  ... + ", 5, <agentBotId>);"
    if (query.includes('+ ", 5);"') || query.includes("+ ', 5);'")) {
      node.parameters.query = query
        .replace('+ ", 5);"', `+ ", 5, ${agentBotId});"`)
        .replace("+ ', 5);'", `+ ', 5, ${agentBotId});'`);
      continue;
    }

    node.parameters.query = query.replace(
      /bot_recover_next_batch\(([\s\S]*?),\s*(\d+)\s*\)/,
      `bot_recover_next_batch($1, $2, ${agentBotId})`,
    );
  }
}

function patchIngestAgentBotId(workflow, spec) {
  const agentBotId = Number(spec.bot.id);
  const prepare = workflow.nodes.find((candidate) => candidate.name === 'Prepare Durable Event');
  if (!prepare?.parameters?.jsCode) return;
  if (prepare.parameters.jsCode.includes(`, ${agentBotId}, ');'`) || prepare.parameters.jsCode.includes(`, ', ', ${agentBotId}, ');'`)) {
    return;
  }

  // Template ends ingest args with: debounceMs, ');'
  if (prepare.parameters.jsCode.includes("debounceMs, ');'")) {
    prepare.parameters.jsCode = prepare.parameters.jsCode.replace(
      "debounceMs, ');'",
      `debounceMs, ', ', ${agentBotId}, ');'`,
    );
  }
}

function patchFaqVectorStore(workflow, spec) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Search FAQ Knowledge Base');
  if (!node) return;
  node.parameters = {
    ...(node.parameters || {}),
    tableName: ragTableName(spec),
    toolDescription:
      'Searches this game\'s official FAQ knowledge base for grounded support answers. Use before answering how-to or troubleshooting questions.',
  };
}

function patchChatMemory(workflow, spec) {
  const node = workflow.nodes.find((candidate) => candidate.name === 'Postgres Chat Memory');
  if (!node) return;
  const tableName = memoryTableName(spec);
  const sessionPrefix = memorySessionPrefix(spec);
  node.parameters = {
    ...(node.parameters || {}),
    tableName,
    sessionKey: `={{ '${sessionPrefix}' + $('Normalize Claimed Batch').item.json.accountId + ':' + $('Normalize Claimed Batch').item.json.conversationId }}`,
  };
}

export function memoryTableName(spec) {
  return identifierPart('helio_bot_memory', spec.bot.id);
}

export function memorySessionPrefix(spec) {
  return `${identifierPart('helio', spec.gameId, spec.bot.id)}:`;
}

const WORKFLOW_CREDENTIALS = {
  openAi: { id: 'openAiPlacehold1', name: 'OpenAI' },
  botPostgres: { id: 'botPgNeonLocal01', name: 'Bot Postgres' },
};

function injectWorkflowCredentials(workflow) {
  for (const node of workflow.nodes) {
    if (['OpenAI Model', 'Embeddings OpenAI', 'Output Fixer Model'].includes(node.name)) {
      node.credentials = { openAiApi: WORKFLOW_CREDENTIALS.openAi };
      continue;
    }
    if (node.name === 'Postgres Chat Memory' || node.name === 'Search FAQ Knowledge Base') {
      node.credentials = { postgres: WORKFLOW_CREDENTIALS.botPostgres };
    }
  }
}

export function ragTableName(spec) {
  return `bot_rag.${identifierPart('faq', spec.gameId, spec.accountId, spec.inboxId, spec.bot.id)}`;
}

function identifierPart(...parts) {
  return parts
    .map((part) => String(part).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('_');
}

function sharedFaqSyncCode(options = {}) {
  const syncSecret = String(options.syncSecret || '').trim();
  const allowedArticleUrlPrefix = String(options.allowedArticleUrlPrefix || '').trim().replace(/\/$/, '');

  return `const input = $input.first().json || {};
const body = input.body || {};
const headers = input.headers || {};
const httpRequest = this.helpers.httpRequest.bind(this.helpers);
const expectedSyncSecret = ${JSON.stringify(syncSecret)};
const allowedArticleUrlPrefix = ${JSON.stringify(allowedArticleUrlPrefix)};

function fail(error) {
  return [{ json: {
    ok: false,
    error: String(error?.message || error || 'FAQ sync failed'),
    articleCount: 0,
    chunkCount: 0,
    query: 'SELECT 1',
  } }];
}

if (!expectedSyncSecret) {
  return fail('FAQ sync secret is not configured');
}

const authHeader = String(headers.authorization || headers.Authorization || '').trim();
if (authHeader !== 'Bearer ' + expectedSyncSecret) {
  return fail('Unauthorized FAQ sync request');
}

const tableName = String(body.ragTableName || '').trim();
const articleUrl = String(body.articleUrl || '').trim();
const botToken = String(body.accessToken || '').trim();
const gameId = String(body.gameId || '').trim();
const accountId = Number(body.accountId);
const inboxId = Number(body.inboxId);
const agentBotId = Number(body.agentBotId);
const portalSlug = body.portalSlug ? String(body.portalSlug) : null;

if (!tableName || !articleUrl || !botToken || !gameId || !Number.isInteger(accountId) || !Number.isInteger(inboxId) || !Number.isInteger(agentBotId)) {
  return fail('ragTableName, articleUrl, accessToken, gameId, accountId, inboxId, and agentBotId are required');
}

if (!allowedArticleUrlPrefix || !articleUrl.startsWith(allowedArticleUrlPrefix + '/')) {
  return fail('articleUrl must start with the configured Helio API base URL');
}

if (!/^bot_rag\\.faq_[a-z0-9_]+$/.test(tableName)) {
  return fail('ragTableName must be a bot_rag.faq_* table');
}

try {

function sqlLiteral(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'";
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\s+/g, ' ')
    .trim();
}

function chunkArticle(article) {
  const text = htmlToText(article.content);
  if (!text) return [];
  const chunks = [];
  const maxLength = 1200;
  const overlap = 180;
  for (let start = 0; start < text.length; start += maxLength - overlap) {
    const chunk = text.slice(start, start + maxLength).trim();
    if (!chunk) continue;
    chunks.push({
      articleId: Number(article.id),
      chunkIndex: chunks.length,
      title: article.title || '',
      slug: article.slug || '',
      locale: article.locale || 'en',
      categoryName: article.categoryName || '',
      content: chunk,
    });
  }
  return chunks;
}

function vectorLiteral(values) {
  if (!Array.isArray(values) || values.length !== 1536) {
    throw new Error('OpenAI embedding response must contain 1536-dimensional vectors');
  }
  return "'[" + values.map((value) => Number(value).toFixed(8)).join(',') + "]'";
}

function insertForChunk(chunk, embedding) {
  const id = ['bot', agentBotId, 'article', chunk.articleId, 'chunk', chunk.chunkIndex].join('_');
  const metadata = {
    source: 'helio_help_center',
    gameId,
    accountId,
    inboxId,
    agentBotId,
    portalSlug,
    articleId: chunk.articleId,
    articleSlug: chunk.slug,
    title: chunk.title,
    locale: chunk.locale,
    categoryName: chunk.categoryName,
  };
  return '(' + [
    sqlLiteral(id),
    accountId,
    inboxId,
    agentBotId,
    sqlLiteral(gameId),
    portalSlug ? sqlLiteral(portalSlug) : 'NULL',
    chunk.articleId,
    chunk.chunkIndex,
    sqlLiteral(chunk.title),
    sqlLiteral(chunk.slug),
    sqlLiteral(chunk.locale),
    sqlLiteral(chunk.categoryName),
    sqlLiteral(chunk.content),
    vectorLiteral(embedding),
    sqlLiteral(JSON.stringify(metadata)) + '::jsonb',
    'now()',
  ].join(', ') + ')';
}

const articlesResponse = await httpRequest({
  method: 'GET',
  url: articleUrl,
  headers: { 'api-access-token': botToken, Accept: 'application/json' },
  json: true,
  timeout: 12000,
});
const articles = Array.isArray(articlesResponse?.data) ? articlesResponse.data : [];
const publishedIds = articles.map((article) => Number(article.id)).filter(Number.isInteger);
const chunks = articles.flatMap(chunkArticle);
const apiKey = String($env.OPENAI_API_KEY || '').trim();
if (chunks.length > 0 && !apiKey) {
  throw new Error('OPENAI_API_KEY is required for FAQ sync embeddings');
}

let embeddings = [];
for (let index = 0; index < chunks.length; index += 64) {
  const batch = chunks.slice(index, index + 64);
  const response = await httpRequest({
    method: 'POST',
    url: 'https://api.openai.com/v1/embeddings',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: {
      model: String($env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'),
      input: batch.map((chunk) => chunk.title + '\\n' + chunk.content),
    },
    json: true,
    timeout: 30000,
  });
  embeddings.push(...(response.data || []).map((item) => item.embedding));
}

const tableIdent = tableName.split('.').map((part) => '"' + part.replace(/"/g, '""') + '"').join('.');
const stalePredicate = publishedIds.length
  ? 'article_id NOT IN (' + publishedIds.join(', ') + ')'
  : 'TRUE';
const valuesSql = chunks.length
  ? 'INSERT INTO ' + tableIdent + ' (id, account_id, inbox_id, agent_bot_id, game_id, portal_slug, article_id, chunk_index, title, article_slug, locale, category_name, content, embedding, metadata, updated_at) VALUES\\n' +
    chunks.map((chunk, index) => insertForChunk(chunk, embeddings[index])).join(',\\n') +
    '\\nON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, article_slug = EXCLUDED.article_slug, locale = EXCLUDED.locale, category_name = EXCLUDED.category_name, content = EXCLUDED.content, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now();'
  : '';
const query = [
  'CREATE EXTENSION IF NOT EXISTS vector;',
  'CREATE SCHEMA IF NOT EXISTS bot_rag;',
  'CREATE TABLE IF NOT EXISTS ' + tableIdent + ' (id text PRIMARY KEY, account_id integer NOT NULL, inbox_id integer NOT NULL, agent_bot_id integer NOT NULL, game_id text NOT NULL, portal_slug text, article_id integer NOT NULL, chunk_index integer NOT NULL, title text NOT NULL, article_slug text NOT NULL, locale text NOT NULL, category_name text, content text NOT NULL, embedding vector(1536) NOT NULL, metadata jsonb NOT NULL DEFAULT \\'{}\\'::jsonb, updated_at timestamptz NOT NULL DEFAULT now());',
  'CREATE INDEX IF NOT EXISTS ' + tableName.replace(/[^a-zA-Z0-9_]/g, '_') + '_agent_article_idx ON ' + tableIdent + ' (agent_bot_id, article_id);',
  'DELETE FROM ' + tableIdent + ' WHERE agent_bot_id = ' + agentBotId + ' AND (' + stalePredicate + ');',
  valuesSql,
].filter(Boolean).join('\\n');

return [{ json: {
  ok: true,
  event: body.event || body.type || 'faq_sync_requested',
  accountId,
  inboxId,
  agentBotId,
  portalSlug,
  tableName,
  articleCount: articles.length,
  chunkCount: chunks.length,
  staleArticleIdsKept: publishedIds,
  query,
  receivedAt: new Date().toISOString(),
} }];
} catch (error) {
  return fail(error);
}`;
}

function replaceEnvReferences(workflow, spec) {
  const helioBaseUrl = spec.helioBaseUrl || process.env.HELIO_BASE_URL || process.env.CHATWOOT_BASE_URL || 'http://host.docker.internal:3000';
  const escalationTeamId = optionalString(spec.botConfig.escalationTeamId) || '';
  const escalationAssigneeId = optionalString(spec.botConfig.escalationAssigneeId) || '';
  const replacements = new Map([
    ['$env.CHATWOOT_BASE_URL', JSON.stringify(helioBaseUrl.replace(/\/$/, ''))],
    ['$env.CHATWOOT_AGENT_BOT_ACCESS_TOKEN', JSON.stringify(spec.bot.accessToken)],
    ['$env.CHATWOOT_API_ACCESS_TOKEN', JSON.stringify(spec.bot.accessToken)],
    ['$env.CHATWOOT_WEBHOOK_SECRET', JSON.stringify(spec.bot.webhookSecret)],
    ['$env.CHATWOOT_WEBHOOK_AUTH_ENFORCED', JSON.stringify('true')],
    ['$env.CHATWOOT_ACCOUNT_ID', JSON.stringify(String(spec.accountId))],
    ['$env.CHATWOOT_INBOX_ID', JSON.stringify(String(spec.inboxId))],
    ['$env.CHATWOOT_PORTAL_SLUG', JSON.stringify(spec.portalSlug || '')],
    ['$env.CHATWOOT_TYPING_INDICATORS', JSON.stringify('true')],
    ['$env.CHATWOOT_ESCALATION_TEAM_ID', JSON.stringify(escalationTeamId)],
    ['$env.CHATWOOT_ESCALATION_ASSIGNEE_ID', JSON.stringify(escalationAssigneeId)],
  ]);

  const patchValue = (value) => {
    if (typeof value === 'string') {
      let next = value;
      for (const [from, to] of replacements.entries()) {
        next = next.split(from).join(to);
      }
      return next;
    }
    if (Array.isArray(value)) return value.map(patchValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, patchValue(child)]));
    }
    return value;
  };

  const patched = patchValue(workflow);
  Object.keys(workflow).forEach((key) => delete workflow[key]);
  Object.assign(workflow, patched);
}

function extractAuthSecret(headers) {
  const get = (name) => headers.get?.(name) || headers[name] || headers[name.toLowerCase()];
  const authorization = String(get('authorization') || '').trim();
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return String(get('x-helio-bot-factory-secret') || '').trim();
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new FactoryError(400, `${field} must be a positive integer`);
  }
  return number;
}

function nonEmptyString(value, field) {
  const string = String(value || '').trim();
  if (!string) {
    throw new FactoryError(400, `${field} is required`);
  }
  return string;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const string = String(value).trim();
  return string || undefined;
}

function optionalNullableString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function workflowPath(...parts) {
  return parts
    .map((part) => String(part).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-');
}

function absoluteUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function webhookUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}/webhook/${path}`;
}

function deterministicId(path, suffix) {
  const hash = crypto.createHash('sha1').update(`${path}:${suffix}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
