import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = JSON.parse(readFileSync(join(root, "workflows/progolf-support-bot-v2-pgvector.json"), "utf8"));
const migration = readFileSync(join(root, "migrations/006_idempotency_debounce.sql"), "utf8");
const switchMigration = readFileSync(join(root, "migrations/007_agent_bot_kill_switch.sql"), "utf8");

const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);
const targets = (name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map((entry) => entry.node);

async function runCode(name, item, overrides = {}) {
  const source = node(name)?.parameters?.jsCode;
  assert.ok(source, `${name} code exists`);
  const script = new vm.Script(`(async () => {\n${source}\n})()`);
  return script.runInNewContext({
    $input: { first: () => ({ json: item }), all: () => [{ json: item }] },
    $json: item,
    $execution: { id: "test-execution" },
    $env: {},
    ...overrides,
  });
}

async function verifyWebhook({ rawBody, headers, env }) {
  const source = node("Verify Chatwoot Webhook")?.parameters?.jsCode;
  assert.ok(source, "webhook verifier code exists");
  const script = new vm.Script(`(async () => {\n${source}\n})()`);
  return script.runInNewContext({
    $input: {
      first: () => ({
        json: { headers, body: JSON.parse(rawBody) },
        binary: { data: { data: Buffer.from(rawBody).toString("base64") } },
      }),
    },
    $env: env,
  });
}

test("migration defines independent delivery/message uniqueness and durable state", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bot_inbound_events/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS bot_inbound_events_delivery_uidx[\s\S]*account_id, delivery_id/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS bot_inbound_events_message_uidx[\s\S]*account_id, message_id/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bot_conversation_leases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bot_outbound_effects/);
  assert.match(migration, /bot_claim_conversation_batch/);
  assert.match(migration, /bot_recover_next_batch/);
  assert.match(migration, /bot_cleanup_idempotency\(p_retention_days INTEGER DEFAULT 30\)/);
});

test("webhook reaches no side effect before durable ingest and batch claim", () => {
  assert.deepEqual(targets("Chatwoot Bot Events"), ["Verify Chatwoot Webhook"]);
  assert.deepEqual(targets("Verify Chatwoot Webhook"), ["Webhook Authorized?"]);
  assert.deepEqual(targets("Webhook Authorized?", 0), ["Respond Authorized"]);
  assert.deepEqual(targets("Webhook Authorized?", 1), ["Reject Unauthorized"]);
  assert.deepEqual(targets("Respond Authorized"), ["Restore Verified Webhook"]);
  assert.deepEqual(targets("Restore Verified Webhook"), ["Extract Event"]);
  assert.deepEqual(targets("Extract Event"), ["Eligible Durable Event?"]);
  assert.deepEqual(targets("Eligible Durable Event?", 0), ["Prepare Durable Event"]);
  assert.deepEqual(targets("Prepare Durable Event"), ["Ingest Durable Event"]);
  assert.deepEqual(targets("Ingest Durable Event"), ["Accepted Durable Event?"]);
  assert.deepEqual(targets("Accepted Durable Event?", 0), ["Wait For Debounce"]);
  assert.deepEqual(targets("Wait For Debounce"), ["Load Agent Bot Switch"]);
  assert.deepEqual(targets("Load Agent Bot Switch"), ["Agent Bot Enabled?"]);
  assert.deepEqual(targets("Agent Bot Enabled?", 0), ["Claim Debounced Batch"]);
  assert.deepEqual(targets("Agent Bot Enabled?", 1), ["Suppress Disabled Event"]);
  assert.deepEqual(targets("Claim Debounced Batch"), ["Normalize Claimed Batch"]);
  assert.deepEqual(targets("Has Claimed Batch?", 0), ["Route Event"]);
});

test("webhook uses raw body and response nodes for fail-closed authentication", () => {
  assert.equal(node("Chatwoot Bot Events").parameters.responseMode, "responseNode");
  assert.equal(node("Chatwoot Bot Events").parameters.options.rawBody, true);
  assert.equal(node("Respond Authorized").parameters.options.responseCode, 200);
  assert.equal(node("Reject Unauthorized").parameters.options.responseCode, 401);
});

test("webhook authentication accepts a valid Chatwoot HMAC", async () => {
  const secret = "test-agent-bot-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    id: 6197,
    account: { id: 2 },
    inbox: { id: 3 },
    conversation: { id: 595, inbox_id: 3 },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const [{ json }] = await verifyWebhook({
    rawBody,
    headers: { "x-chatwoot-timestamp": timestamp, "x-chatwoot-signature": signature },
    env: {
      CHATWOOT_WEBHOOK_AUTH_ENFORCED: "true",
      CHATWOOT_WEBHOOK_SECRET: secret,
      CHATWOOT_ACCOUNT_ID: "2",
      CHATWOOT_INBOX_ID: "3",
    },
  });
  assert.deepEqual({ ...json.webhookAuth }, { authorized: true, enforced: true, reason: "verified" });
});

test("webhook authentication rejects tampering, stale requests, and wrong scope", async () => {
  const secret = "test-agent-bot-secret";
  const validTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ account: { id: 2 }, inbox: { id: 3 }, conversation: { inbox_id: 3 } });
  const signatureFor = (timestamp) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const baseEnv = {
    CHATWOOT_WEBHOOK_AUTH_ENFORCED: "true",
    CHATWOOT_WEBHOOK_SECRET: secret,
    CHATWOOT_ACCOUNT_ID: "2",
    CHATWOOT_INBOX_ID: "3",
  };

  const cases = [
    { headers: { "x-chatwoot-timestamp": validTimestamp, "x-chatwoot-signature": `${signatureFor(validTimestamp).slice(0, -1)}${signatureFor(validTimestamp).endsWith("0") ? "1" : "0"}` }, env: baseEnv },
    { headers: { "x-chatwoot-timestamp": "1", "x-chatwoot-signature": signatureFor("1") }, env: baseEnv },
    { headers: { "x-chatwoot-timestamp": validTimestamp, "x-chatwoot-signature": signatureFor(validTimestamp) }, env: { ...baseEnv, CHATWOOT_ACCOUNT_ID: "99" } },
    { headers: { "x-chatwoot-timestamp": validTimestamp, "x-chatwoot-signature": signatureFor(validTimestamp) }, env: { ...baseEnv, CHATWOOT_INBOX_ID: "99" } },
    { headers: { "x-chatwoot-timestamp": validTimestamp, "x-chatwoot-signature": signatureFor(validTimestamp) }, env: { ...baseEnv, CHATWOOT_WEBHOOK_SECRET: "" } },
  ];

  for (const candidate of cases) {
    const [{ json }] = await verifyWebhook({ rawBody, ...candidate });
    assert.equal(json.webhookAuth.authorized, false, json.webhookAuth.reason);
  }
});

test("webhook authentication compatibility mode preserves traffic until configured", async () => {
  const rawBody = JSON.stringify({ account: { id: 2 }, inbox: { id: 3 } });
  const [{ json }] = await verifyWebhook({ rawBody, headers: {}, env: { CHATWOOT_WEBHOOK_AUTH_ENFORCED: "false" } });
  assert.deepEqual({ ...json.webhookAuth }, { authorized: true, enforced: false, reason: "auth_not_enforced" });
});

test("recovery and cleanup schedules are wired", () => {
  assert.deepEqual(targets("Recovery Schedule"), ["Load Recovery Switch"]);
  assert.deepEqual(targets("Load Recovery Switch"), ["Recovery Enabled?"]);
  assert.deepEqual(targets("Recovery Enabled?", 0), ["Recover Next Batch"]);
  assert.deepEqual(targets("Recover Next Batch"), ["Normalize Claimed Batch"]);
  assert.deepEqual(targets("Cleanup Schedule"), ["Cleanup Idempotency Records"]);
  assert.equal(node("Recovery Schedule").parameters.rule.interval[0].secondsInterval, 10);
});

test("emergency switch defaults on and fails closed in normal and recovery paths", () => {
  assert.match(switchMigration, /CREATE TABLE IF NOT EXISTS bot_runtime_settings/);
  assert.match(switchMigration, /agent_bot_enabled', TRUE/);
  assert.match(switchMigration, /bot_set_agent_enabled/);
  assert.equal(node("Load Agent Bot Switch").onError, "continueRegularOutput");
  assert.equal(node("Load Recovery Switch").onError, "continueRegularOutput");
  assert.match(node("Suppress Disabled Event").parameters.query, /agent_bot_disabled/);
});

test("batch claims never busy-wait in Postgres", () => {
  assert.doesNotMatch(migration, /PERFORM\s+pg_sleep/i);
  assert.doesNotMatch(migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION bot_claim_conversation_batch"), migration.indexOf("CREATE OR REPLACE FUNCTION bot_recover_next_batch")), /\bLOOP\b/i);
  assert.match(node("Claim Debounced Batch").parameters.query, /, 0,/);
  assert.match(String(node("Wait For Debounce").parameters.amount), /CONVERSATION_DEBOUNCE_MS/);
});

test("every persistent Chatwoot effect is claimed and completed", () => {
  for (const name of [
    "Save Escalation Context", "Send Reply", "Send Escalation Form", "Post Internal Note",
    "Label Conversation", "Notify Player", "Open Conversation",
  ]) {
    assert.ok(node(`Claim ${name}`), `claim exists for ${name}`);
    assert.ok(node(`Run ${name}?`), `decision exists for ${name}`);
    assert.ok(node(`Complete ${name}`), `completion exists for ${name}`);
    assert.deepEqual(targets(`Claim ${name}`), [`Run ${name}?`]);
    assert.deepEqual(targets(`Run ${name}?`, 0), [name]);
    assert.deepEqual(targets(name), [`Complete ${name}`]);
  }
  assert.deepEqual(targets("Complete Send Reply"), ["Finalize Batch"]);
  assert.deepEqual(targets("Complete Send Escalation Form"), ["Finalize Batch"]);
  assert.deepEqual(targets("Complete Open Conversation"), ["Finalize Batch"]);
});

test("outgoing messages carry deterministic reconciliation keys", () => {
  for (const name of ["Send Reply", "Send Escalation Form", "Post Internal Note", "Notify Player"]) {
    assert.match(node(name).parameters.jsonBody, /n8n_idempotency_key/, name);
  }
});

test("public Chatwoot messages use the agent bot token when configured", () => {
  const botToken = /CHATWOOT_AGENT_BOT_ACCESS_TOKEN \|\| \$env\.CHATWOOT_API_ACCESS_TOKEN/;
  for (const name of ["Send Reply", "Send Escalation Form", "Notify Player"]) {
    assert.match(node(name).parameters.headerParameters.parameters[0].value, botToken, name);
  }
  for (const name of ["Save Escalation Context", "Post Internal Note", "Label Conversation", "Open Conversation"]) {
    assert.equal(node(name).parameters.headerParameters.parameters[0].value, "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}", name);
  }
});

test("typing and effect guards restore the durable context they replace", () => {
  assert.deepEqual(targets("Typing On"), ["Restore Debounced Context"]);
  assert.deepEqual(targets("Typing Indicators Enabled?", 1), ["Restore Debounced Context"]);
  assert.deepEqual(targets("Restore Debounced Context"), ["Support Agent"]);
  assert.match(node("Restore Debounced Context").parameters.jsCode, /Normalize Claimed Batch/);
  assert.match(node("Send Reply").parameters.jsonBody, /Merge QA With Routing Decision/);
  assert.match(node("Save Escalation Context").parameters.jsonBody, /Build Escalation Form/);
});

test("event extraction captures Chatwoot delivery and message identifiers", async () => {
  const webhook = {
    headers: { "x-chatwoot-delivery": "delivery-1", "x-chatwoot-timestamp": "1770000000" },
    body: {
      id: 6197,
      event: "message_created",
      message_type: "incoming",
      content: "first message",
      account: { id: 2 },
      conversation: { id: 595, status: "pending", meta: { sender: { name: "Player" } } },
    },
  };
  const [{ json }] = await runCode("Extract Event", webhook);
  assert.equal(json.route, "user_message");
  assert.equal(json.deliveryId, "delivery-1");
  assert.equal(json.messageId, 6197);
  assert.equal(json.accountId, 2);
  assert.equal(json.conversationId, 595);
});

test("batch normalization preserves latest context and ordered combined content", async () => {
  const [{ json }] = await runCode("Normalize Claimed Batch", {
    should_process: true,
    batch_id: "batch-a",
    event_ids: [10, 11, 12],
    combined_content: "one\ntwo\nthree",
    event_context: { accountId: 2, conversationId: 595, route: "user_message", content: "three" },
    reason: "claimed",
  });
  assert.equal(json.shouldProcess, true);
  assert.equal(json.content, "one\ntwo\nthree");
  assert.equal(json.batchId, "batch-a");
  assert.deepEqual(Array.from(json.eventIds), [10, 11, 12]);
});

test("workflow code nodes compile and downstream URLs use durable context", () => {
  for (const candidate of workflow.nodes) {
    if (!candidate.parameters?.jsCode) continue;
    assert.doesNotThrow(() => new vm.Script(`(async () => {\n${candidate.parameters.jsCode}\n})()`), candidate.name);
  }
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /\$\('Extract Event'\)\.item\.json/);
});
