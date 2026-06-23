import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadV4Workflow() {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-bot-with-rag-v4.json"), "utf8");
  return JSON.parse(raw);
}

async function runCodeNode(workflow, nodeName, item, context = {}) {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  assert.ok(node, `${nodeName} node exists`);
  const code = node.parameters?.jsCode;
  assert.ok(code, `${nodeName} has jsCode`);
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  return script.runInNewContext({
    $input: {
      first: () => ({ json: item }),
      all: () => [{ json: item }],
    },
    $json: item,
    $env: {},
    ...context,
  });
}

test("v4 workflow JSON parses and Code nodes compile", () => {
  const workflow = loadV4Workflow();
  assert.equal(workflow.name, "Chatwoot Guided Flow + RAG Bot v4 (retrieve then classify)");
  for (const node of workflow.nodes) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    assert.doesNotThrow(
      () => new vm.Script(`(async () => {\n${code}\n})()`),
      `${node.name} should compile`,
    );
  }
});

test("v4 uses retrieve-then-classify nodes and single renderer fan-in", () => {
  const workflow = loadV4Workflow();
  const names = new Set(workflow.nodes.map((node) => node.name));
  const webhook = workflow.nodes.find((node) => node.name === "Webhook AgentBot");
  const pinecone = workflow.nodes.find((node) => node.name === "Pinecone Retrieve");
  const chain = workflow.nodes.find((node) => node.name === "Route & Answer LLM");

  assert.ok(names.has("Render Guided Node"));
  assert.ok(names.has("Build Router Prompt"));
  assert.ok(!names.has("RAG Guided Agent"));
  assert.equal(webhook.parameters.path, "chatwoot-guided-with-rag-v4");
  assert.equal(pinecone.parameters.mode, "load");
  assert.equal(chain.type, "@n8n/n8n-nodes-langchain.chainLlm");
  assert.equal(workflow.connections["Guided action is LLM?"].main[0][0].node, "Pinecone Retrieve");
  assert.equal(workflow.connections["Guided action is LLM?"].main[1][0].node, "Render Guided Node");
  assert.equal(workflow.connections["Evaluate RAG Answer"].main[0][0].node, "Render Guided Node");
  assert.equal(workflow.connections["Render Guided Node"].main[0][0].node, "RAG action is guided?");
});

test("v4 guided router emits decisions and renderer owns message bodies", async () => {
  const workflow = loadV4Workflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {},
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "other",
    isInteractiveSubmission: true,
    interactiveContentType: "input_select",
    submittedValues: [{ title: "Other", value: "other" }],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedMessageBody, undefined);
  assert.equal(routed.guidedDecision.kind, "render");
  assert.equal(routed.guidedDecision.nodeId, "llm");

  const [{ json: rendered }] = await runCodeNode(workflow, "Render Guided Node", routed);
  assert.equal(rendered.guidedAction, "guided_reply");
  assert.equal(rendered.nextGuidedState.current_node, "llm");
  assert.match(rendered.guidedMessageBody.content, /describe your issue/i);
});

test("v4 free text routes to retrieval without rendering first", async () => {
  const workflow = loadV4Workflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {},
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "How do withdrawals work?",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, "llm");
  assert.equal(routed.guidedDecision.kind, "llm");
  assert.equal(routed.guidedMessageBody, undefined);
  assert.ok(Array.isArray(routed.guidedDecision.routeContext.guided_entry_targets));
});

test("v4 greeting text re-renders the guided menu instead of routing to LLM", async () => {
  const workflow = loadV4Workflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "main",
        mode: "options",
        step: "options",
        path: [],
        form_data: {},
      },
    },
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "hi",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, undefined);
  assert.equal(routed.guidedDecision.kind, "render");
  assert.equal(routed.guidedDecision.nodeId, "main");

  const [{ json: rendered }] = await runCodeNode(workflow, "Render Guided Node", routed);
  assert.equal(rendered.guidedAction, "guided_reply");
  assert.equal(rendered.nextGuidedState.current_node, "main");
  assert.match(rendered.guidedMessageBody.content, /how can we help/i);
});

test("v4 evaluator rejects ungrounded FAQ answers in code", async () => {
  const workflow = loadV4Workflow();
  const upstream = {
    conversationId: 1,
    userText: "How do withdrawals work?",
    guidedFlow: { version: 1, entry: "main", nodes: { main: { type: "options", options: [] } } },
    guidedState: { current_node: "main", path: [], form_data: {} },
    routeContext: { guided_entry_targets: [] },
    retrievedChunks: [{ id: "doc-a", score: 0.92, text: "Supported answer." }],
    retrievedMaxScore: 0.92,
    guardrailRiskFlags: [],
    guardrailLabels: [],
    agentOutput: {
      route: "faq",
      answer: "Use the withdrawals menu.",
      confidence: 0.9,
      rag_answerable: true,
      knowledge_used: ["doc-b"],
      risk_flags: [],
      labels: [],
      private_summary: "FAQ answer",
    },
  };

  const [{ json: evaluated }] = await runCodeNode(workflow, "Evaluate RAG Answer", {}, {
    $: () => ({ first: () => ({ json: upstream }) }),
    $env: { RAG_MIN_SCORE: "0.72" },
  });

  assert.equal(evaluated.guidedDecision.kind, "handoff");
  assert.match(evaluated.guidedDecision.privateSummary, /knowledge_subset=false/);
});

test("v4 meta-dialog special targets resume pending guided state", async () => {
  const workflow = loadV4Workflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "faq_recovery_menu",
        mode: "faq_recovery",
        step: "awaiting_recovery_choice",
        pending_route: {
          faq_answer: "You can check your rewards inbox.",
          previous_guided_state: {
            current_node: "missing_reward_form",
            mode: "form",
            step: "form",
            path: ["report_game_issue"],
            form_data: {},
          },
        },
      },
    },
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "faq_continue_report",
    isInteractiveSubmission: true,
    interactiveContentType: "input_select",
    submittedValues: [{ title: "Continue my report", value: "faq_continue_report" }],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedDecision.kind, "render");
  assert.equal(routed.guidedDecision.nodeId, "missing_reward_form");

  const [{ json: rendered }] = await runCodeNode(workflow, "Render Guided Node", routed);
  assert.equal(rendered.guidedMessageBody.content, "Please provide the required information below.");
  assert.equal(rendered.guidedMessageBody.content_type, "form");
});

test("v4 renderer interpolates pending-route prompts", async () => {
  const workflow = loadV4Workflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {},
  });

  const [{ json: rendered }] = await runCodeNode(workflow, "Render Guided Node", {
    ...withFlow,
    guidedDecision: {
      kind: "render",
      nodeId: "route_clarification_menu",
      statePatch: {
        pending_route: {
          clarification_prompt: "Would you like an article answer or help with a report?",
        },
      },
    },
  });

  assert.equal(rendered.guidedMessageBody.content, "Would you like an article answer or help with a report?");
  assert.equal(rendered.guidedMessageBody.content_type, "input_select");
});
