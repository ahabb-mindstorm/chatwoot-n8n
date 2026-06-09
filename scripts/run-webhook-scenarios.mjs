#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_DELAY_MS = 3500;
const WEBHOOK_PATH = 'chatwoot-guided-with-rag';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function loadEnvFile(path) {
  if (!path) return;
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function requiredNumber(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Missing or invalid ${name}. Pass --${name.replaceAll('_', '-')} or set ${name.toUpperCase()}.`);
  }
  return number;
}

function normalizeWebhookUrl(value, mode = 'production') {
  if (!value) throw new Error('Missing webhook URL. Pass --webhook-url or set N8N_WEBHOOK_URL.');
  const trimmed = String(value).replace(/\/+$/, '');
  if (/\/webhook(-test)?\/[^/]+$/.test(trimmed)) return trimmed;
  const prefix = mode === 'test' ? 'webhook-test' : 'webhook';
  return `${trimmed}/${prefix}/${WEBHOOK_PATH}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scenarioDefinitions() {
  return {
    'faq-smoke': [
      { type: 'reset' },
      { type: 'text', text: 'menu' },
      { type: 'text', text: 'how to withdraw?' },
      { type: 'text', text: 'what is the capital of France?' },
    ],
    'missing-reward-no-attach': [
      { type: 'reset' },
      { type: 'text', text: 'menu' },
      { type: 'select', value: 'missing_reward', title: 'Missing Reward' },
      {
        type: 'form',
        values: {
          reward_lost: 'Tournament reward',
          lost_at: 'Yesterday evening',
          lost_location: 'Tournament results screen',
          other_missing_rewards: 'No',
        },
      },
      { type: 'select', value: 'nothing_to_attach', title: 'Nothing to attach' },
    ],
    'ad-attachment': [
      { type: 'reset' },
      { type: 'text', text: 'I got an inappropriate ad' },
      {
        type: 'form',
        values: {
          ad_content: 'The ad showed inappropriate content',
          most_recent_ad: 'yes',
          additional_comments: 'It appeared after a tournament.',
        },
      },
      { type: 'attachment', fileName: 'ad-screenshot.png', contentType: 'image/png', fileType: 'image' },
    ],
    'guided-breakout': [
      { type: 'reset' },
      { type: 'text', text: 'menu' },
      { type: 'select', value: 'missing_reward', title: 'Missing Reward' },
      { type: 'text', text: 'what are coins used for?' },
      { type: 'text', text: 'I still need to report a missing reward' },
    ],
    'guardrails': [
      { type: 'reset' },
      { type: 'text', text: 'I need to talk to a real person' },
      { type: 'text', text: 'delete my data under GDPR' },
    ],
  };
}

function loadScenario(args) {
  if (args['scenario-file']) {
    const parsed = JSON.parse(readFileSync(args['scenario-file'], 'utf8'));
    if (!Array.isArray(parsed.steps)) throw new Error('Scenario file must contain a top-level steps array.');
    return { name: parsed.name || args['scenario-file'], steps: parsed.steps };
  }

  const name = args.scenario || 'faq-smoke';
  const scenarios = scenarioDefinitions();
  if (args['list-scenarios']) {
    console.log(Object.keys(scenarios).join('\n'));
    process.exit(0);
  }
  if (!scenarios[name]) {
    throw new Error(`Unknown scenario "${name}". Use --list-scenarios to see available scenarios.`);
  }
  return { name, steps: scenarios[name] };
}

function submittedValuesFrom(valueMap) {
  return Object.entries(valueMap || {}).map(([name, value]) => ({ name, value }));
}

function createHarness(config) {
  let sequence = Number(config.startMessageId || Date.now());
  const createdAt = nowSeconds();

  function nextMessageId() {
    sequence += 1;
    return sequence;
  }

  function basePayload(message, event = 'message_created') {
    const messageId = message.id || nextMessageId();
    const content = message.content ?? '';
    const sender = {
      additional_attributes: {},
      custom_attributes: {},
      email: null,
      id: config.contactId,
      identifier: null,
      name: config.contactName,
      phone_number: null,
      thumbnail: '',
      blocked: false,
      type: 'contact',
    };

    const conversationMessage = {
      id: messageId,
      content,
      account_id: config.accountId,
      inbox_id: config.inboxId,
      conversation_id: config.conversationId,
      message_type: 0,
      created_at: createdAt,
      updated_at: new Date().toISOString(),
      private: false,
      status: 'sent',
      source_id: null,
      content_type: message.content_type || 'text',
      content_attributes: message.content_attributes || {},
      sender_type: 'Contact',
      sender_id: config.contactId,
      external_source_ids: {},
      additional_attributes: { test_run_id: config.runId },
      processed_message_content: content,
      sentiment: {},
      conversation: {
        assignee_id: config.assigneeId,
        unread_count: 1,
        last_activity_at: createdAt,
      },
      sender,
      attachments: message.attachments || [],
    };

    return {
      account: { id: config.accountId, name: config.accountName },
      additional_attributes: { test_run_id: config.runId, harness: 'scripts/run-webhook-scenarios.mjs' },
      content_attributes: message.content_attributes || {},
      content_type: message.content_type || 'text',
      content,
      conversation: {
        additional_attributes: { test_run_id: config.runId },
        can_reply: true,
        channel: 'Channel::WebWidget',
        contact_inbox: {
          id: config.contactInboxId,
          contact_id: config.contactId,
          inbox_id: config.inboxId,
          source_id: config.sourceId,
          hmac_verified: false,
        },
        custom_attributes: {},
        id: config.conversationId,
        inbox_id: config.inboxId,
        labels: [],
        messages: [conversationMessage],
        meta: {
          sender,
          assignee: config.assigneeId ? { id: config.assigneeId, name: config.assigneeName, type: 'user' } : null,
          assignee_type: config.assigneeId ? 'User' : null,
          hmac_verified: false,
        },
        status: 'open',
        timestamp: createdAt,
      },
      created_at: new Date().toISOString(),
      id: messageId,
      inbox: { id: config.inboxId, name: config.inboxName },
      message_type: 'incoming',
      private: false,
      sender,
      source_id: null,
      event,
      message: {
        ...conversationMessage,
        content_type: message.content_type || 'text',
        content_attributes: message.content_attributes || {},
        attachments: message.attachments || [],
      },
    };
  }

  function textPayload(step) {
    return basePayload({ content: step.text, content_type: 'text' });
  }

  function selectPayload(step) {
    const value = step.value || step.id || step.title;
    const title = step.title || step.text || value;
    return basePayload(
      {
        content: title,
        content_type: 'input_select',
        content_attributes: { submitted_values: [{ name: 'selection', value, title }] },
      },
      'message_updated',
    );
  }

  function formPayload(step) {
    const values = step.values || {};
    return basePayload(
      {
        content: JSON.stringify(values),
        content_type: 'form',
        content_attributes: { submitted_values: submittedValuesFrom(values) },
      },
      'message_updated',
    );
  }

  function attachmentPayload(step) {
    const messageId = nextMessageId();
    const fileName = step.fileName || 'attachment.png';
    const extension = fileName.includes('.') ? fileName.split('.').pop() : null;
    const attachment = {
      id: step.attachmentId || `test-attachment-${messageId}`,
      message_id: messageId,
      file_type: step.fileType || 'image',
      extension,
      content_type: step.contentType || 'image/png',
      file_size: Number(step.fileSize || 12345),
      width: step.width || 800,
      height: step.height || 600,
    };
    return basePayload({ id: messageId, content: null, content_type: 'text', attachments: [attachment] });
  }

  function resetPayload(step) {
    const updatedAt = new Date().toISOString();
    return {
      event: 'conversation_status_changed',
      status: 'resolved',
      account: { id: config.accountId, name: config.accountName },
      account_id: config.accountId,
      id: config.conversationId,
      conversation_id: config.conversationId,
      custom_attributes: {},
      updated_at: updatedAt,
      timestamp: Date.now(),
      additional_attributes: { test_run_id: config.runId, reason: step.reason || 'scenario_reset' },
      messages: [{ account_id: config.accountId }],
    };
  }

  function payloadFor(step) {
    if (step.type === 'text') return textPayload(step);
    if (step.type === 'select') return selectPayload(step);
    if (step.type === 'form') return formPayload(step);
    if (step.type === 'attachment') return attachmentPayload(step);
    if (step.type === 'reset') return resetPayload(step);
    throw new Error(`Unsupported step type "${step.type}".`);
  }

  return { payloadFor };
}

async function postWebhook(url, headers, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep raw body.
  }
  return { ok: response.ok, status: response.status, body };
}

function configFrom(args, scenarioName) {
  const runId = args['run-id'] || `webhook-scenario-${scenarioName}-${new Date().toISOString()}`;
  return {
    webhookUrl: normalizeWebhookUrl(args['webhook-url'] || process.env.N8N_WEBHOOK_URL, args.mode || process.env.N8N_WEBHOOK_MODE || 'production'),
    secret: args.secret || process.env.CHATWOOT_WEBHOOK_SECRET || '',
    accountId: requiredNumber('account_id', args['account-id'] || process.env.CHATWOOT_TEST_ACCOUNT_ID),
    conversationId: requiredNumber('conversation_id', args['conversation-id'] || process.env.CHATWOOT_TEST_CONVERSATION_ID),
    inboxId: requiredNumber('inbox_id', args['inbox-id'] || process.env.CHATWOOT_TEST_INBOX_ID),
    contactId: requiredNumber('contact_id', args['contact-id'] || process.env.CHATWOOT_TEST_CONTACT_ID),
    contactInboxId: Number(args['contact-inbox-id'] || process.env.CHATWOOT_TEST_CONTACT_INBOX_ID || args['contact-id'] || process.env.CHATWOOT_TEST_CONTACT_ID),
    assigneeId: Number(args['assignee-id'] || process.env.CHATWOOT_TEST_ASSIGNEE_ID || 0),
    assigneeName: args['assignee-name'] || process.env.CHATWOOT_TEST_ASSIGNEE_NAME || 'Test Assignee',
    accountName: args['account-name'] || process.env.CHATWOOT_TEST_ACCOUNT_NAME || 'Test Account',
    inboxName: args['inbox-name'] || process.env.CHATWOOT_TEST_INBOX_NAME || 'ProGolf Support',
    contactName: args['contact-name'] || process.env.CHATWOOT_TEST_CONTACT_NAME || 'webhook-scenario-user',
    sourceId: args['source-id'] || process.env.CHATWOOT_TEST_SOURCE_ID || `test-source-${Date.now()}`,
    delayMs: Number(args.delay || process.env.WEBHOOK_SCENARIO_DELAY_MS || DEFAULT_DELAY_MS),
    runId,
    startMessageId: args['start-message-id'] || process.env.WEBHOOK_SCENARIO_START_MESSAGE_ID,
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/run-webhook-scenarios.mjs --env-file .env.scenario --scenario faq-smoke

Required:
  --webhook-url URL              Base n8n URL or full /webhook/chatwoot-guided-with-rag URL
  --account-id ID
  --conversation-id ID
  --inbox-id ID
  --contact-id ID

Useful:
  --scenario NAME                Built-in scenario name (default: faq-smoke)
  --scenario-file FILE           JSON file with { "name": "...", "steps": [...] }
  --mode production|test         Uses /webhook or /webhook-test when base URL is passed
  --delay MS                     Delay between steps; default ${DEFAULT_DELAY_MS}
  --run-id ID                    Marker added to payload additional_attributes
  --list-scenarios

Environment equivalents:
  N8N_WEBHOOK_URL, CHATWOOT_TEST_ACCOUNT_ID, CHATWOOT_TEST_CONVERSATION_ID,
  CHATWOOT_TEST_INBOX_ID, CHATWOOT_TEST_CONTACT_ID, CHATWOOT_WEBHOOK_SECRET
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  loadEnvFile(args['env-file']);
  const scenario = loadScenario(args);
  const config = configFrom(args, scenario.name);
  const harness = createHarness(config);
  const startedAt = new Date().toISOString();
  const headers = {
    'x-chatwoot-delivery': config.runId,
    ...(config.secret ? { 'x-webhook-secret': config.secret } : {}),
  };

  console.log(JSON.stringify({
    event: 'scenario_start',
    scenario: scenario.name,
    runId: config.runId,
    startedAt,
    webhookUrl: config.webhookUrl,
    conversationId: config.conversationId,
    stepCount: scenario.steps.length,
  }, null, 2));

  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index];
    if (step.type === 'sleep') {
      const ms = Number(step.ms || config.delayMs);
      console.log(JSON.stringify({ event: 'sleep', index: index + 1, ms }));
      await sleep(ms);
      continue;
    }

    const payload = harness.payloadFor(step);
    const messageId = payload.message?.id || payload.id || payload.conversation_id;
    console.log(JSON.stringify({
      event: 'send',
      index: index + 1,
      type: step.type,
      messageId,
      text: step.text || step.title || step.value || null,
    }));
    const result = await postWebhook(config.webhookUrl, headers, payload);
    console.log(JSON.stringify({
      event: 'response',
      index: index + 1,
      status: result.status,
      ok: result.ok,
      body: result.body,
    }));
    if (!result.ok) process.exitCode = 1;
    if (index < scenario.steps.length - 1) await sleep(Number(step.delayAfter || config.delayMs));
  }

  console.log(JSON.stringify({
    event: 'scenario_done',
    scenario: scenario.name,
    runId: config.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    mcpHint: `search_executions workflowId=pi1FV25pGTEu4rwm startedAfter=${startedAt}`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
