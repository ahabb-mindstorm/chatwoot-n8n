import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const inputPath = process.argv[2] || join(root, "workflows/progolf-support-bot-v2-pgvector.json");
const outputPath = process.argv[3] || inputPath;
const workflow = JSON.parse(readFileSync(inputPath, "utf8"));

const postgresCredentials = { postgres: { name: "Bot Postgres" } };
const managedNames = new Set([
  "Eligible Durable Event?", "Prepare Durable Event", "Ingest Durable Event", "Accepted Durable Event?",
  "Verify Chatwoot Webhook", "Webhook Authorized?", "Respond Authorized", "Restore Verified Webhook", "Reject Unauthorized",
  "Wait For Debounce", "Load Agent Bot Switch", "Agent Bot Enabled?", "Suppress Disabled Event",
  "Claim Debounced Batch", "Normalize Claimed Batch", "Has Claimed Batch?", "Recovery Schedule",
  "Load Recovery Switch", "Recovery Enabled?",
  "Recover Next Batch", "Cleanup Schedule", "Cleanup Idempotency Records", "Finalize Batch",
  "Restore Debounced Context",
]);

for (const effect of [
  "Save Escalation Context", "Send Reply", "Send Escalation Form", "Post Internal Note",
  "Label Conversation", "Notify Player", "Open Conversation",
]) {
  managedNames.add(`Claim ${effect}`);
  managedNames.add(`Run ${effect}?`);
  managedNames.add(`Complete ${effect}`);
}

workflow.nodes = workflow.nodes.filter((node) => !managedNames.has(node.name));
for (const name of managedNames) delete workflow.connections[name];

const byName = (name) => workflow.nodes.find((node) => node.name === name);
const add = (node) => workflow.nodes.push(node);
const connect = (source, target, output = 0) => {
  workflow.connections[source] ||= { main: [] };
  workflow.connections[source].main ||= [];
  workflow.connections[source].main[output] ||= [];
  workflow.connections[source].main[output].push({ node: target, type: "main", index: 0 });
};
const replaceConnections = (source, outputs) => {
  workflow.connections[source] = { main: outputs.map((targets) => targets.map((target) => ({ node: target, type: "main", index: 0 }))) };
};
const postgresNode = (id, name, position, query, extra = {}) => ({
  id, name, type: "n8n-nodes-base.postgres", typeVersion: 2.6, position,
  parameters: { operation: "executeQuery", query, options: { queryBatching: "single" } },
  credentials: postgresCredentials, ...extra,
});
const ifNode = (id, name, position, leftValue) => ({
  id, name, type: "n8n-nodes-base.if", typeVersion: 2.3, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{ id: `${id}-condition`, leftValue, rightValue: true, operator: { type: "boolean", operation: "equals" } }],
      combinator: "and",
    },
    options: {},
  },
});

const extract = byName("Extract Event");
if (!extract) throw new Error("Extract Event node not found");
let extractCode = extract.parameters.jsCode;
if (!extractCode.includes("const requestHeaders =")) {
  extractCode = extractCode.replace(
    "const body = $input.first().json.body || {};",
    "const webhookInput = $input.first().json || {};\nconst requestHeaders = webhookInput.headers || {};\nconst body = webhookInput.body || {};",
  );
  extractCode = extractCode.replace(
    "  route,\n  accountId:",
    "  route,\n  deliveryId: requestHeaders['x-chatwoot-delivery'] || requestHeaders['X-Chatwoot-Delivery'] || null,\n  messageId: body.id || body.message?.id || (Array.isArray(body.messages) ? body.messages[0]?.id : null) || null,\n  eventType: event,\n  eventTimestamp: requestHeaders['x-chatwoot-timestamp'] || requestHeaders['X-Chatwoot-Timestamp'] || body.created_at || null,\n  accountId:",
  );
}
extract.parameters.jsCode = extractCode;

// Recovery executions do not run Extract Event, so every downstream expression uses the durable batch context.
for (const node of workflow.nodes) {
  const rewrite = (value) => typeof value === "string"
    ? value.replaceAll("$('Extract Event').item.json", "$('Normalize Claimed Batch').item.json")
    : value;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) value[key] = walk(child);
      return value;
    }
    return rewrite(value);
  };
  node.parameters = walk(node.parameters || {});
}

const prepareCode = `const item = $input.first().json;
const webhook = $('Chatwoot Bot Events').first().json || {};
const sqlText = (value) => value === null || value === undefined || value === '' ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'";
const sqlJson = (value) => "'" + JSON.stringify(value || {}).replace(/'/g, "''") + "'::jsonb";
const eventTimestamp = item.eventTimestamp && !Number.isNaN(Number(item.eventTimestamp))
  ? new Date(Number(item.eventTimestamp) * 1000).toISOString()
  : item.eventTimestamp;
const normalized = { ...item };
delete normalized.ingestSql;
const debounceMs = Math.max(0, Number($env.CONVERSATION_DEBOUNCE_MS || 2000));
const ingestSql = [
  'SELECT * FROM bot_ingest_event(',
  Number(item.accountId), ', ', Number(item.conversationId), ', ',
  sqlText(item.deliveryId), ', ', sqlText(item.messageId), ', ', sqlText(item.eventType), ', ',
  eventTimestamp ? sqlText(eventTimestamp) + '::timestamptz' : 'NULL', ', ',
  sqlText(item.content || ''), ', ', sqlJson(normalized), ', ', sqlJson(webhook), ', ', debounceMs, ');'
].join('');
return [{ json: { ...item, ingestSql } }];`;

const webhookAuthCode = `const item = $input.first();
const json = item.json || {};
const headers = json.headers || {};
const body = json.body || {};
const enforced = String($env.CHATWOOT_WEBHOOK_AUTH_ENFORCED || 'false').trim().toLowerCase() === 'true';

function utf8Bytes(text) {
  const out = [];
  for (const char of String(text)) {
    const cp = char.codePointAt(0);
    if (cp <= 0x7f) out.push(cp);
    else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function base64Bytes(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(value || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === '=') break;
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function sha256(bytes) {
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const data = bytes.slice();
  const bitLength = data.length * 8;
  data.push(0x80);
  while ((data.length % 64) !== 56) data.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) data.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) data.push((low >>> shift) & 0xff);
  const rotr = (value, amount) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  const out = [];
  for (const word of h) for (let shift = 24; shift >= 0; shift -= 8) out.push((word >>> shift) & 0xff);
  return out;
}

function hmacHex(key, messageBytes) {
  let keyBytes = utf8Bytes(key);
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
  while (keyBytes.length < 64) keyBytes.push(0);
  const outer = keyBytes.map((byte) => byte ^ 0x5c);
  const inner = keyBytes.map((byte) => byte ^ 0x36);
  const digest = sha256(inner.concat(messageBytes));
  return sha256(outer.concat(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(actual, expected) {
  const left = String(actual || '').toLowerCase();
  const right = String(expected || '').toLowerCase();
  let diff = left.length ^ right.length;
  for (let i = 0; i < right.length; i++) diff |= right.charCodeAt(i) ^ (left.charCodeAt(i) || 0);
  return diff === 0;
}

let authorized = !enforced;
let reason = enforced ? 'unauthorized' : 'auth_not_enforced';
if (enforced) {
  const secret = String($env.CHATWOOT_WEBHOOK_SECRET || '').trim();
  const timestamp = String(headers['x-chatwoot-timestamp'] || '').trim();
  const signature = String(headers['x-chatwoot-signature'] || '').trim();
  const rawBase64 = item.binary?.data?.data || '';
  const timestampSeconds = Number(timestamp);
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  const expectedAccount = String($env.CHATWOOT_ACCOUNT_ID || '').trim();
  const expectedInbox = String($env.CHATWOOT_INBOX_ID || '').trim();
  const accountId = String(body.account?.id ?? body.conversation?.account_id ?? '');
  const inboxId = String(body.inbox?.id ?? body.conversation?.inbox_id ?? '');
  if (!secret) reason = 'missing_secret';
  else if (!/^\\d+$/.test(timestamp) || !Number.isFinite(timestampSeconds)) reason = 'invalid_timestamp';
  else if (ageSeconds > 300) reason = 'expired_timestamp';
  else if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) reason = 'invalid_signature_format';
  else if (!rawBase64) reason = 'missing_raw_body';
  else if (!expectedAccount || accountId !== expectedAccount) reason = 'unexpected_account';
  else if (!expectedInbox || inboxId !== expectedInbox) reason = 'unexpected_inbox';
  else {
    const messageBytes = utf8Bytes(timestamp + '.').concat(base64Bytes(rawBase64));
    const expected = 'sha256=' + hmacHex(secret, messageBytes);
    authorized = constantTimeEqual(signature, expected);
    reason = authorized ? 'verified' : 'signature_mismatch';
  }
}

return [{ json: { ...json, webhookAuth: { authorized, enforced, reason } } }];`;

add(ifNode("idem-eligible", "Eligible Durable Event?", [448, 384], "={{ $json.route !== 'ignore' }}"));
const webhook = byName("Chatwoot Bot Events");
webhook.parameters.responseMode = "responseNode";
webhook.parameters.options = { ...(webhook.parameters.options || {}), rawBody: true };
add({ id: "webhook-auth-verify", name: "Verify Chatwoot Webhook", type: "n8n-nodes-base.code", typeVersion: 2, position: [224, 384], parameters: { jsCode: webhookAuthCode } });
add(ifNode("webhook-auth-if", "Webhook Authorized?", [448, 384], "={{ $json.webhookAuth.authorized === true }}"));
add({ id: "webhook-auth-ok", name: "Respond Authorized", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5, position: [672, 288], parameters: { respondWith: "json", responseBody: "={{ { ok: true } }}", options: { responseCode: 200 } } });
add({ id: "webhook-auth-restore", name: "Restore Verified Webhook", type: "n8n-nodes-base.code", typeVersion: 2, position: [896, 288], parameters: { jsCode: "const verified = $('Verify Chatwoot Webhook').first().json || {};\nreturn [{ json: { ...verified } }];" } });
add({ id: "webhook-auth-reject", name: "Reject Unauthorized", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.5, position: [672, 512], parameters: { respondWith: "json", responseBody: "={{ { error: 'unauthorized' } }}", options: { responseCode: 401, responseHeaders: { entries: [{ name: "Cache-Control", value: "no-store" }] } } } });
add({ id: "idem-prepare", name: "Prepare Durable Event", type: "n8n-nodes-base.code", typeVersion: 2, position: [672, 384], parameters: { jsCode: prepareCode } });
add(postgresNode("idem-ingest", "Ingest Durable Event", [896, 384], "={{ $json.ingestSql }}", { alwaysOutputData: true }));
add(ifNode("idem-accepted", "Accepted Durable Event?", [1120, 384], "={{ $json.accepted === true }}"));
add({
  id: "idem-wait-debounce",
  name: "Wait For Debounce",
  type: "n8n-nodes-base.wait",
  typeVersion: 1.1,
  position: [1232, 384],
  parameters: {
    amount: "={{ (Math.max(0, Number($env.CONVERSATION_DEBOUNCE_MS || 2000)) + 250) / 1000 }}",
    unit: "seconds",
  },
});
add(postgresNode(
  "kill-switch-load",
  "Load Agent Bot Switch",
  [1344, 384],
  "SELECT COALESCE((SELECT enabled FROM bot_runtime_settings WHERE setting_key = 'agent_bot_enabled'), FALSE) AS enabled;",
  { alwaysOutputData: true, onError: "continueRegularOutput" },
));
add(ifNode("kill-switch-if", "Agent Bot Enabled?", [1456, 384], "={{ $json.enabled === true }}"));
add(postgresNode(
  "kill-switch-suppress",
  "Suppress Disabled Event",
  [1568, 544],
  "={{ 'UPDATE bot_inbound_events SET status = \'dead_letter\', last_error = \'agent_bot_disabled\', updated_at = clock_timestamp() WHERE id = ' + Number($('Ingest Durable Event').item.json.event_id) + ' AND status = \'pending\' RETURNING id, status, last_error;' }}",
  { alwaysOutputData: true, onError: "continueRegularOutput" },
));
add(postgresNode(
  "idem-claim", "Claim Debounced Batch", [1680, 384],
  `={{ "SELECT * FROM bot_claim_conversation_batch(" + Number($('Prepare Durable Event').item.json.accountId) + ", " + Number($('Prepare Durable Event').item.json.conversationId) + ", '" + String($execution.id).replace(/'/g, "''") + "', 0, " + Math.max(30, Number($env.CONVERSATION_LEASE_SECONDS || 300)) + ");" }}`,
  { alwaysOutputData: true },
));

const normalizeBatchCode = `const row = $input.first().json || {};
let context = row.event_context || {};
if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = {}; } }
const shouldProcess = row.should_process === true || row.should_process === 'true';
return [{ json: {
  ...context,
  content: row.combined_content || context.content || '',
  batchId: row.batch_id || null,
  eventIds: row.event_ids || [],
  shouldProcess,
  claimReason: row.reason || '',
  executionOwner: String($execution.id),
} }];`;
add({ id: "idem-normalize-batch", name: "Normalize Claimed Batch", type: "n8n-nodes-base.code", typeVersion: 2, position: [1568, 384], parameters: { jsCode: normalizeBatchCode } });
add(ifNode("idem-has-batch", "Has Claimed Batch?", [1792, 384], "={{ $json.shouldProcess === true }}"));
add({
  id: "idem-restore-context",
  name: "Restore Debounced Context",
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [1344, 208],
  parameters: {
    jsCode: "const context = $('Normalize Claimed Batch').first().json || {};\nreturn [{ json: { ...context } }];",
  },
});

add({
  id: "idem-recovery-schedule", name: "Recovery Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.3,
  position: [1120, 672], parameters: { rule: { interval: [{ field: "seconds", secondsInterval: 10 }] } },
});
add(postgresNode(
  "kill-switch-recovery-load",
  "Load Recovery Switch",
  [1232, 672],
  "SELECT COALESCE((SELECT enabled FROM bot_runtime_settings WHERE setting_key = 'agent_bot_enabled'), FALSE) AS enabled;",
  { alwaysOutputData: true, onError: "continueRegularOutput" },
));
add(ifNode("kill-switch-recovery-if", "Recovery Enabled?", [1344, 672], "={{ $json.enabled === true }}"));
add(postgresNode(
  "idem-recover", "Recover Next Batch", [1456, 672],
  "={{ \"SELECT * FROM bot_recover_next_batch('\" + String($execution.id).replace(/'/g, \"''\") + \"', \" + Math.max(30, Number($env.CONVERSATION_LEASE_SECONDS || 300)) + \", 5);\" }}",
  { alwaysOutputData: true },
));
add({
  id: "idem-cleanup-schedule", name: "Cleanup Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.3,
  position: [1120, 864], parameters: { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 17 }] } },
});
add(postgresNode("idem-cleanup", "Cleanup Idempotency Records", [1344, 864], "={{ 'SELECT * FROM bot_cleanup_idempotency(' + Math.max(1, Number($env.IDEMPOTENCY_RETENTION_DAYS || 30)) + ');' }}"));
add(postgresNode(
  "idem-finalize", "Finalize Batch", [4800, 384],
  "={{ \"SELECT bot_finalize_batch('\" + String($('Normalize Claimed Batch').item.json.batchId).replace(/'/g, \"''\") + \"', '\" + String($('Normalize Claimed Batch').item.json.executionOwner).replace(/'/g, \"''\") + \"', NULL);\" }}",
  { alwaysOutputData: true },
));

replaceConnections("Chatwoot Bot Events", [["Verify Chatwoot Webhook"]]);
replaceConnections("Verify Chatwoot Webhook", [["Webhook Authorized?"]]);
replaceConnections("Webhook Authorized?", [["Respond Authorized"], ["Reject Unauthorized"]]);
replaceConnections("Respond Authorized", [["Restore Verified Webhook"]]);
replaceConnections("Restore Verified Webhook", [["Extract Event"]]);
replaceConnections("Extract Event", [["Eligible Durable Event?"]]);
replaceConnections("Eligible Durable Event?", [["Prepare Durable Event"], []]);
replaceConnections("Prepare Durable Event", [["Ingest Durable Event"]]);
replaceConnections("Ingest Durable Event", [["Accepted Durable Event?"]]);
replaceConnections("Accepted Durable Event?", [["Wait For Debounce"], []]);
replaceConnections("Wait For Debounce", [["Load Agent Bot Switch"]]);
replaceConnections("Load Agent Bot Switch", [["Agent Bot Enabled?"]]);
replaceConnections("Agent Bot Enabled?", [["Claim Debounced Batch"], ["Suppress Disabled Event"]]);
replaceConnections("Claim Debounced Batch", [["Normalize Claimed Batch"]]);
replaceConnections("Recover Next Batch", [["Normalize Claimed Batch"]]);
replaceConnections("Normalize Claimed Batch", [["Has Claimed Batch?"]]);
replaceConnections("Has Claimed Batch?", [["Route Event"], []]);
replaceConnections("Recovery Schedule", [["Load Recovery Switch"]]);
replaceConnections("Load Recovery Switch", [["Recovery Enabled?"]]);
replaceConnections("Recovery Enabled?", [["Recover Next Batch"], []]);
replaceConnections("Cleanup Schedule", [["Cleanup Idempotency Records"]]);
replaceConnections("Typing Indicators Enabled?", [["Wait Before Typing"], ["Restore Debounced Context"]]);
replaceConnections("Typing On", [["Restore Debounced Context"]]);
replaceConnections("Restore Debounced Context", [["Support Agent"]]);

const effectSpecs = [
  { name: "Save Escalation Context", slug: "save_escalation_context", next: "Route Saved Escalation" },
  { name: "Send Reply", slug: "send_reply", next: "Finalize Batch", message: true },
  { name: "Send Escalation Form", slug: "send_escalation_form", next: "Finalize Batch", message: true },
  { name: "Post Internal Note", slug: "post_internal_note", next: "Claim Label Conversation", message: true },
  { name: "Label Conversation", slug: "label_conversation", next: "Typing Off Before Notify" },
  { name: "Notify Player", slug: "notify_player", next: "Claim Open Conversation", message: true },
  { name: "Open Conversation", slug: "open_conversation", next: "Finalize Batch" },
];

for (const [index, spec] of effectSpecs.entries()) {
  const target = byName(spec.name);
  if (!target) throw new Error(`${spec.name} node not found`);
  const x = 2600 + index * 260;
  const claimName = `Claim ${spec.name}`;
  const runName = `Run ${spec.name}?`;
  const completeName = `Complete ${spec.name}`;
  const effectKeyExpression = `$('Normalize Claimed Batch').item.json.batchId + ':${spec.slug}:1'`;
  const claimQuery = `={{ "SELECT * FROM bot_claim_outbound_effect(" + Number($('Normalize Claimed Batch').item.json.accountId) + ", " + Number($('Normalize Claimed Batch').item.json.conversationId) + ", '" + String($('Normalize Claimed Batch').item.json.batchId).replace(/'/g, "''") + "', '" + String(${effectKeyExpression}).replace(/'/g, "''") + "', '${spec.slug}', jsonb_build_object('batch_id', '" + String($('Normalize Claimed Batch').item.json.batchId).replace(/'/g, "''") + "'), '" + String($execution.id).replace(/'/g, "''") + "', " + Math.max(30, Number($env.CONVERSATION_LEASE_SECONDS || 300)) + ");" }}`;
  const completeQuery = `={{ "SELECT bot_complete_outbound_effect('" + String(${effectKeyExpression}).replace(/'/g, "''") + "', '" + JSON.stringify($json || {}).replace(/'/g, "''") + "'::jsonb, " + ($json.id ? "'" + String($json.id).replace(/'/g, "''") + "'" : "NULL") + ");" }}`;
  add(postgresNode(`effect-claim-${spec.slug}`, claimName, [x, 1040], claimQuery, { alwaysOutputData: true }));
  add(ifNode(`effect-if-${spec.slug}`, runName, [x + 180, 1040], "={{ $json.should_run === true }}"));
  add(postgresNode(`effect-complete-${spec.slug}`, completeName, [x + 360, 1040], completeQuery, { alwaysOutputData: true }));
  replaceConnections(claimName, [[runName]]);
  replaceConnections(runName, [[spec.name], [spec.next]]);
  replaceConnections(spec.name, [[completeName]]);
  replaceConnections(completeName, [[spec.next]]);

  if (spec.message) {
    const keyObject = `{ n8n_idempotency_key: ${effectKeyExpression} }`;
    if (spec.name === "Send Reply") {
      target.parameters.jsonBody = `={{ JSON.stringify({ content: $('Merge QA With Routing Decision').item.json.output.reply, private: false, content_attributes: ${keyObject} }) }}`;
    } else if (spec.name === "Send Escalation Form") {
      target.parameters.jsonBody = `={{ JSON.stringify({ ...$('Build Escalation Form').item.json.formBody, content_attributes: { ...(($('Build Escalation Form').item.json.formBody || {}).content_attributes || {}), n8n_idempotency_key: ${effectKeyExpression} } }) }}`;
    } else if (spec.name === "Post Internal Note") {
      target.parameters.jsonBody = `={{ JSON.stringify({ content: $('Prepare Handoff').item.json.noteContent, message_type: 'outgoing', private: true, content_attributes: ${keyObject} }) }}`;
    } else if (spec.name === "Notify Player") {
      target.parameters.jsonBody = `={{ JSON.stringify({ content: $('Prepare Handoff').item.json.confirmText, private: false, content_attributes: ${keyObject} }) }}`;
    }
  }
}

byName("Save Escalation Context").parameters.jsonBody = "={{ JSON.stringify($('Build Escalation Form').item.json.attrsBody) }}";

// Redirect the existing durable side-effect entry points through their claims.
replaceConnections("Typing Off Before Reply", [["Claim Send Reply"]]);
replaceConnections("Build Escalation Form", [["Claim Save Escalation Context"]]);
replaceConnections("Typing Off Before Form", [["Claim Send Escalation Form"]]);
replaceConnections("Prepare Handoff", [["Claim Post Internal Note"]]);
replaceConnections("Complete Save Escalation Context", [["Route Saved Escalation"]]);
replaceConnections("Complete Post Internal Note", [["Claim Label Conversation"]]);
replaceConnections("Complete Label Conversation", [["Typing Off Before Notify"]]);
replaceConnections("Typing Off Before Notify", [["Claim Notify Player"]]);
replaceConnections("Complete Notify Player", [["Claim Open Conversation"]]);

workflow.settings ||= {};
workflow.settings.executionOrder = "v1";
writeFileSync(outputPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Patched ${outputPath} with durable idempotency, debounce, recovery, and effect ledgers`);
