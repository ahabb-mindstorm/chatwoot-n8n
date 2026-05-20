import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

import { validateClassifier, parseClassifierOutput, CLASSIFIER_JSON_SCHEMA } from "../lib/classifier.mjs";
import { runGuidedFlow, isActiveFlow, buildLightweightCustomAttributes } from "../lib/guidedFlowEngine.mjs";
import { evaluateRetrieval, evaluateFaqAnswer } from "../lib/ragFaq.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadWorkflow() {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot-postgres.json"), "utf8");
  return JSON.parse(raw);
}

async function runCodeNode(workflow, nodeName, item, extraContext = {}) {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  assert.ok(node, `${nodeName} node exists`);
  const code = node.parameters?.jsCode;
  assert.ok(code, `${nodeName} has jsCode`);
  const context = {
    $input: { first: () => ({ json: item }), all: () => [{ json: item }] },
    $json: item,
    $env: {
      CLASSIFIER_MIN_CONFIDENCE: "0.65",
      DEFAULT_GUIDED_FLOW_ID: "support_main",
      RAG_MIN_SCORE: "0.72",
      CONVERSATION_DEBOUNCE_MS: "2000",
      ...extraContext.env,
    },
    ...extraContext,
  };
  if (extraContext.nodes) {
    for (const [name, data] of Object.entries(extraContext.nodes)) {
      context.$ = (selector) => ({
        first: () => ({
          json: typeof selector === "string" && selector.includes(name) ? data : item,
        }),
      });
      context[`$('${name}')`] = {
        first: () => ({ json: data }),
      };
    }
  }
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  return script.runInContext(vm.createContext(context));
}

test("postgres workflow JSON parses", () => {
  loadWorkflow();
});

test("legacy support workflow JSON unchanged on disk", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  assert.equal(workflow.meta?.templateId, "chatwoot-support-bot");
});

test("postgres workflow Code nodes compile", () => {
  const workflow = loadWorkflow();
  for (const node of workflow.nodes) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    assert.doesNotThrow(
      () => new vm.Script(`(async () => {\n${code}\n})()`),
      `${node.name} should compile`,
    );
  }
});

test("postgres workflow contains required nodes and classifier parser wiring", () => {
  const workflow = loadWorkflow();
  const names = new Set(workflow.nodes.map((node) => node.name));
  const required = [
    "Normalize Chatwoot Payload",
    "Idempotency / Debounce",
    "Load Bot State from Postgres",
    "Router: Active Flow?",
    "Fetch Guided Flow",
    "Continue Guided Flow",
    "Classify Message",
    "Classifier Structured Output Parser",
    "Validate Classifier Output",
    "Route Intent",
    "RAG FAQ Answer",
    "Start Guided Flow",
    "Clarification Reply",
    "Human Handoff",
    "Merge Bot Outcome",
    "Persist Bot State",
    "Persist Flow Submission",
    "Persist Audit Event",
    "Update Chatwoot Custom Attributes",
    "Send Chatwoot Reply",
    "Assign Team",
  ];
  for (const name of required) assert.ok(names.has(name), `missing node ${name}`);

  assert.ok(workflow.nodes.some((n) => n.type === "@n8n/n8n-nodes-langchain.outputParserStructured"));
  const agent = workflow.nodes.find((n) => n.name === "Classify Message");
  assert.equal(agent.parameters.hasOutputParser, true);
  assert.ok(workflow.connections["Classifier Structured Output Parser"]?.ai_outputParser);
  assert.ok(workflow.connections["OpenAI Classifier Model"]?.ai_languageModel);

  const updateAttrs = workflow.nodes.find((n) => n.name === "Update Chatwoot Custom Attributes");
  assert.ok(updateAttrs.parameters.jsonBody.includes("lightweightAttributes"));
  assert.ok(!updateAttrs.parameters.jsonBody.includes("n8n_guided_flow"));

  const webhook = workflow.nodes.find((n) => n.name === "Webhook AgentBot");
  assert.equal(webhook.parameters.path, "chatwoot-support-bot-postgres");
});

test("classifier validation fails closed on bad route", () => {
  const parsed = parseClassifierOutput({ route: "unknown", intent: "x", confidence: 0.9, requires_human: false });
  const validated = validateClassifier(parsed.value);
  assert.equal(validated.ok, false);
  assert.equal(validated.route, "human_handoff");
});

test("guided flow engine starts menu for greeting", () => {
  const result = runGuidedFlow({
    item: { userText: "hi", guardrailRiskFlags: [], accountId: 1, conversationId: 2, messageId: "3" },
    dbState: null,
    startNew: true,
  });
  assert.equal(result.guidedAction, "guided_reply");
  assert.equal(result.currentNode, "main");
});

test("lightweight custom attributes exclude full flow state", () => {
  const attrs = buildLightweightCustomAttributes({
    activeFlowId: "support_main",
    intent: "guided_flow",
    caseType: "guided_flow",
    botStatus: "active",
    currentStep: "options",
    privateSummary: "x".repeat(500),
  });
  assert.equal(attrs.active_flow, "support_main");
  assert.ok(attrs.agent_summary.length <= 240);
  assert.equal(attrs.n8n_guided_flow, undefined);
});

test("isActiveFlow uses postgres flow_status", () => {
  assert.equal(isActiveFlow({ flow_status: "active", active_flow_id: "support_main", bot_status: "active" }), true);
  assert.equal(isActiveFlow({ flow_status: "active", active_flow_id: "support_main", bot_status: "handoff" }), false);
});

test("FAQ evaluation fail-closed when retrieval weak", () => {
  const faq = evaluateFaqAnswer({
    answer: "Some answer",
    retrieval: evaluateRetrieval([], { RAG_MIN_SCORE: "0.72" }),
    riskFlags: [],
  });
  assert.equal(faq.action, "handoff");
});

test("CLASSIFIER_JSON_SCHEMA includes required route enum", () => {
  assert.ok(CLASSIFIER_JSON_SCHEMA.properties.route.enum.includes("clarification"));
});
