#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from 'pg';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_ACCOUNT_ID = 2;
const DEFAULT_INBOX_ID = 1;

function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function intEnv(name, fallback) {
  const value = Number(env(name, fallback));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function requestJson(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  }
  return json;
}

async function resolveWidgetContext({ accountId, inboxId }) {
  const explicit = {
    inboxIdentifier: env('HELIO_PUBLIC_INBOX_IDENTIFIER'),
    sourceId: env('HELIO_CONTACT_SOURCE_ID'),
  };
  if (explicit.inboxIdentifier && explicit.sourceId) return explicit;

  const databaseUrl = env('DATABASE_URL') || env('HELIO_DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('Set HELIO_PUBLIC_INBOX_IDENTIFIER + HELIO_CONTACT_SOURCE_ID, or set DATABASE_URL/HELIO_DATABASE_URL for context lookup');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select ca.identifier
         from inboxes i
         join channel_api ca on ca.id = i.channel_id
        where i.account_id = $1 and i.id = $2
        limit 1`,
      [accountId, inboxId],
    );
    if (!rows[0]?.identifier) throw new Error(`No Channel::Api identifier found for account ${accountId} inbox ${inboxId}`);
    return {
      inboxIdentifier: rows[0].identifier,
      sourceId: env('HELIO_CONTACT_SOURCE_ID', `contract-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`),
    };
  } finally {
    await client.end();
  }
}

function signRawBody(secret, timestamp, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function verifyGeneratedSignature() {
  const secret = env('HELIO_WEBHOOK_SECRET', 'contract-secret');
  const timestamp = '1783424400';
  const rawBody = JSON.stringify({ event: 'message_created', id: 123 });
  const signature = signRawBody(secret, timestamp, rawBody);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.equal(signature, signRawBody(secret, timestamp, rawBody));
  return { timestamp, signatureHeader: 'sha256=<verified>' };
}

async function createPublicConversation(baseUrl, inboxIdentifier, sourceId) {
  await requestJson(baseUrl, `/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}/contacts`, {
    method: 'POST',
    body: {
      source_id: sourceId,
      name: 'Contract Test Player',
      email: `${sourceId}@example.test`,
    },
  });

  return requestJson(baseUrl, `/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}/contacts/${encodeURIComponent(sourceId)}/conversations`, {
    method: 'POST',
    body: { custom_attributes: { contract_test: true } },
  });
}

async function verifyPrivateNote(baseUrl, accountId, conversationId, botToken, inboxIdentifier, sourceId) {
  const note = await requestJson(baseUrl, `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'api-access-token': botToken },
    body: {
      content: 'contract private note',
      private: true,
    },
  });
  assert.equal(note.content, 'contract private note');
  assert.equal(note.message_type, 1);

  const visible = await requestJson(baseUrl, `/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}/contacts/${encodeURIComponent(sourceId)}/conversations/${conversationId}/messages`);
  assert.ok(Array.isArray(visible));
  assert.equal(visible.some((message) => message.id === note.id), false);

  return { privateNoteId: note.id };
}

async function verifyInteractiveForm(baseUrl, accountId, conversationId, botToken, inboxIdentifier, sourceId) {
  const botMessage = await requestJson(baseUrl, `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'api-access-token': botToken },
    body: {
      content: 'Choose one',
      content_type: 'input_select',
      content_attributes: {
        items: [
          { title: 'Withdrawal', value: 'withdrawal' },
          { title: 'Technical issue', value: 'technical_issue' },
        ],
      },
    },
  });
  assert.equal(botMessage.content_type, 'input_select');
  assert.equal(botMessage.content_attributes.content_type, 'input_select');
  assert.equal(botMessage.content_attributes.items.length, 2);

  const submitted = await requestJson(baseUrl, `/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}/contacts/${encodeURIComponent(sourceId)}/conversations/${conversationId}/messages/${botMessage.id}`, {
    method: 'PATCH',
    body: {
      submitted_values: [
        { name: 'topic', title: 'Withdrawal', value: 'withdrawal' },
      ],
    },
  });
  assert.equal(submitted.id, botMessage.id);
  assert.equal(submitted.content_attributes.submitted, true);
  assert.deepEqual(submitted.content_attributes.submitted_values, [
    { name: 'topic', title: 'Withdrawal', value: 'withdrawal' },
  ]);

  return { interactiveMessageId: botMessage.id };
}

async function main() {
  const baseUrl = env('HELIO_BASE_URL', env('CHATWOOT_BASE_URL', DEFAULT_BASE_URL));
  const accountId = intEnv('HELIO_ACCOUNT_ID', env('CHATWOOT_ACCOUNT_ID', DEFAULT_ACCOUNT_ID));
  const inboxId = intEnv('HELIO_INBOX_ID', env('CHATWOOT_INBOX_ID', DEFAULT_INBOX_ID));
  const botToken = env('HELIO_BOT_TOKEN', env('CHATWOOT_AGENT_BOT_ACCESS_TOKEN', env('CHATWOOT_API_ACCESS_TOKEN')));
  if (!botToken) throw new Error('Set HELIO_BOT_TOKEN or CHATWOOT_AGENT_BOT_ACCESS_TOKEN');

  const { inboxIdentifier, sourceId } = await resolveWidgetContext({ accountId, inboxId });
  const conversation = env('HELIO_CONVERSATION_ID')
    ? { id: intEnv('HELIO_CONVERSATION_ID') }
    : await createPublicConversation(baseUrl, inboxIdentifier, sourceId);
  const signature = verifyGeneratedSignature();
  const privateNote = await verifyPrivateNote(baseUrl, accountId, conversation.id, botToken, inboxIdentifier, sourceId);
  const interactive = await verifyInteractiveForm(baseUrl, accountId, conversation.id, botToken, inboxIdentifier, sourceId);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    accountId,
    inboxId,
    conversationId: conversation.id,
    checks: {
      privateNotes: privateNote,
      inputSelectAndSubmittedValues: interactive,
      hmacSignatureShape: signature,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
