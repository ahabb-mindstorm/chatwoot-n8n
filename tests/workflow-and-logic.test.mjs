import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { evaluateSafety, nextFailureState } from "../lib/safetyGate.mjs";
import { validateAgentBotEnvelope } from "../lib/webhookValidate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

test("workflow JSON parses", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  JSON.parse(raw);
});

test("workflow contains planned AI Agent and context nodes", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  const names = new Set(workflow.nodes.map((node) => node.name));
  const types = new Set(workflow.nodes.map((node) => node.type));

  assert.ok(types.has("@n8n/n8n-nodes-langchain.agent"));
  assert.ok(names.has("Chatwoot Get Conversation"));
  assert.ok(names.has("Chatwoot List Messages"));
  assert.ok(names.has("Chatwoot Get Contact"));
  assert.ok(names.has("Intent Router"));
  assert.ok(names.has("Knowledge Retrieval"));
  assert.ok(names.has("Tool Call Placeholders"));
  assert.ok(names.has("CRM Tool Placeholder"));
  assert.ok(names.has("Order Tool Placeholder"));
  assert.ok(names.has("Status Tool Placeholder"));
  assert.ok(names.has("Failed Turn Tracker"));
});

test("setup script uses account API by default and platform API as option", () => {
  const script = readFileSync(join(rootDir, "scripts/setup-agent-bot.sh"), "utf8");
  assert.match(script, /CHATWOOT_AGENT_BOT_API:-account/);
  assert.ok(script.includes("/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/agent_bots"));
  assert.ok(script.includes("/platform/api/v1/agent_bots"));
  assert.ok(!script.includes("/platform/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/agent_bots"));
});

test("validate accepts nested Agent Bot customer incoming", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_created",
        message: {
          id: 9,
          message_type: 0,
          content: "hello",
          private: false,
          sender: { type: "contact" },
        },
        account: { id: 1 },
        conversation: { id: 2, inbox_id: 3 },
      },
      headers: {},
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.senderType, "contact");
  assert.equal(res.data.contactId, undefined);
});

test("validate accepts top-level Chatwoot message_created customer incoming", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_created",
        id: 77,
        content: "Need help",
        message_type: "incoming",
        private: false,
        sender: { id: 44, type: "contact" },
        contact: { id: 44, name: "Ada" },
        account: { id: 1 },
        conversation: { id: 2, inbox_id: 3 },
        inbox: { id: 3 },
      },
      headers: {},
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.messageId, 77);
  assert.equal(res.data.userText, "Need help");
  assert.equal(res.data.contactId, 44);
});

test("validate accepts Chatwoot payload with sender_type Contact", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_created",
        id: 88,
        content: "yo",
        message_type: "incoming",
        sender_type: "Contact",
        sender_id: 55,
        account: { id: 1 },
        conversation: { id: 2, inbox_id: 3 },
      },
      headers: {},
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.senderType, "contact");
  assert.equal(res.data.userText, "yo");
});

test("validate rejects agent outgoing", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_created",
        message: {
          id: 9,
          message_type: 1,
          content: "hi",
          private: false,
          sender: { type: "user" },
        },
        account: { id: 1 },
        conversation: { id: 2 },
      },
    },
    {},
  );
  assert.equal(res.ok, false);
});

test("safety escalates low confidence", () => {
  const out = evaluateSafety({
    agent: {
      answer: "ok",
      confidence: 0.5,
      needs_human: false,
      risk_flags: [],
      labels: [],
      private_summary: "x",
    },
    upstream: { accountId: 1 },
    httpError: false,
  });
  assert.equal(out.action, "escalate");
});

test("safety replies when safe", () => {
  const out = evaluateSafety({
    agent: {
      answer: "Short safe answer.",
      confidence: 0.9,
      needs_human: false,
      risk_flags: [],
      labels: [],
      private_summary: "x",
    },
    upstream: { accountId: 1 },
    httpError: false,
  });
  assert.equal(out.action, "reply");
});

test("safety escalates on risk flag", () => {
  const out = evaluateSafety({
    agent: {
      answer: "maybe",
      confidence: 0.9,
      needs_human: false,
      risk_flags: ["billing_dispute"],
      labels: [],
      private_summary: "x",
    },
    upstream: { accountId: 1 },
    httpError: false,
  });
  assert.equal(out.action, "escalate");
});

test("safety escalates missing or too long answer", () => {
  assert.equal(
    evaluateSafety({
      agent: { answer: "", confidence: 0.99, needs_human: false, risk_flags: [] },
      upstream: {},
      httpError: false,
    }).action,
    "escalate",
  );

  assert.equal(
    evaluateSafety({
      agent: {
        answer: "x".repeat(1201),
        confidence: 0.99,
        needs_human: false,
        risk_flags: [],
      },
      upstream: {},
      httpError: false,
    }).action,
    "escalate",
  );
});

test("safety escalates on tool failure", () => {
  const out = evaluateSafety({ agent: null, upstream: {}, httpError: true });
  assert.equal(out.action, "escalate");
  assert.match(out.privateSummary, /tool_failed/);
});

test("failure state escalates after two failed turns and resets on reply", () => {
  const first = nextFailureState({
    conversationId: 12,
    previous: {},
    safety: { action: "escalate", confidence: 0.2 },
  });
  assert.equal(first.forceEscalate, false);

  const second = nextFailureState({
    conversationId: 12,
    previous: first.counts,
    safety: { action: "escalate", confidence: 0.2 },
  });
  assert.equal(second.forceEscalate, true);

  const reset = nextFailureState({
    conversationId: 12,
    previous: second.counts,
    safety: { action: "reply", confidence: 0.9 },
  });
  assert.equal(reset.failedTurnCount, 0);
});
