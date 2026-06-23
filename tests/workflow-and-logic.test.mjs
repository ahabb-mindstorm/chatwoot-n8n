import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

import { evaluateSafety, nextFailureState } from "../lib/safetyGate.mjs";
import { validateAgentBotEnvelope } from "../lib/webhookValidate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadWorkflow() {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  return JSON.parse(raw);
}

function loadV3Workflow() {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-bot-with-rag-v3.json"), "utf8");
  return JSON.parse(raw);
}

async function runCodeNode(workflow, nodeName, item, context = {}) {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  assert.ok(node, `${nodeName} node exists`);
  const code = node.parameters?.jsCode;
  assert.ok(code, `${nodeName} has jsCode`);
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  return script.runInNewContext({
    $input: { first: () => ({ json: item }) },
    $json: item,
    $env: {},
    ...context,
  });
}

function metadataRoutingFlow() {
  return {
    version: 1,
    entry: "main",
    nodes: {
      main: {
        type: "options",
        prompt: "Main menu",
        options: [{ id: "gameissues", text: "Game Issues", target: "gameissues" }],
      },
      missing_reward: {
        type: "form",
        prompt: "Please provide details.",
        routing: {
          allowDirectRouting: true,
          intent: "missing_reward",
          description: "Route here when user reports missing, lost, or unreceived rewards.",
          examples: ["I did not get my reward"],
          negative_examples: ["How do rewards work?"],
        },
        fields: [{ id: "details", label: "Details", type: "text", required: true }],
        submitTarget: "human",
      },
      gameissues: {
        type: "options",
        prompt: "What game issue?",
        options: [
          {
            id: "missing_reward",
            text: "Missing Reward",
            target: "missing_reward",
            routing: {
              description: "Choose this option when user says a reward is missing.",
              examples: ["missing reward"],
            },
          },
        ],
      },
      faqCheck_13: { type: "faqCheck", prompt: "Checking FAQ", target: "report_shared" },
      report_shared: { type: "text", content: "Report shared.", next: "human" },
      human: { type: "human" },
    },
  };
}

async function runEvaluateRagAnswer(workflow, upstream) {
  return runCodeNode(workflow, "Evaluate RAG Answer", {}, {
    $: () => ({ first: () => ({ json: upstream }) }),
  });
}

test("workflow JSON parses", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  JSON.parse(raw);
});

test("workflow Code node JavaScript compiles", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  for (const node of workflow.nodes) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    assert.doesNotThrow(
      () => new vm.Script(`(async () => {\n${code}\n})()`),
      `${node.name} should compile`,
    );
  }
});

test("v3 workflow resets guided state on resolved status changes", async () => {
  const workflow = loadV3Workflow();
  const [{ json: normalized }] = await runCodeNode(workflow, "Validate & Normalize", {
    headers: { "x-chatwoot-delivery": "delivery-333" },
    body: {
      event: "conversation_status_changed",
      status: "resolved",
      id: 23,
      custom_attributes: {
        n8n_guided_flow: {
          flow_version: 1,
          current_node: "llm",
          path: ["withdrawal"],
          form_data: { old: true },
          llm_turns: 3,
        },
        other_attribute: "keep",
      },
      messages: [{ account_id: 2 }],
    },
  });

  assert.equal(normalized.resetOnly, true);
  assert.equal(normalized.accountId, 2);
  assert.equal(normalized.conversationId, 23);
  assert.match(normalized.messageId, /^status:23:/);
  assert.equal(normalized.customAttributes.other_attribute, "keep");

  const staticData = {
    failedTurns: { 23: 2 },
    convDebounce: { 23: Date.now() },
  };
  const [{ json: reset }] = await runCodeNode(workflow, "Prepare Conversation Reset", normalized, {
    $getWorkflowStaticData: () => staticData,
  });

  assert.equal(staticData.failedTurns[23], undefined);
  assert.equal(staticData.convDebounce[23], undefined);
  assert.equal(reset.customAttributes.other_attribute, "keep");
  assert.equal(reset.customAttributes.n8n_guided_flow.mode, "completed");
  assert.equal(reset.customAttributes.n8n_guided_flow.step, "chatwoot_resolved");
  assert.equal(reset.customAttributes.n8n_guided_flow.resolved, true);
  assert.equal(Array.isArray(reset.customAttributes.n8n_guided_flow.path), true);
  assert.equal(reset.customAttributes.n8n_guided_flow.path.length, 0);
});

test("v3 handoff public reply includes conversation id as ticket id", () => {
  const workflow = loadV3Workflow();
  const handoffReply = workflow.nodes.find((node) => node.name === "Chatwoot Handoff Public Reply");
  assert.ok(handoffReply, "Chatwoot Handoff Public Reply node exists");
  const jsonBody = handoffReply.parameters.jsonBody;
  assert.ok(jsonBody.includes("conversationId"), "handoff reply should reference conversationId");
  assert.ok(jsonBody.includes("Ticket ID"), "handoff reply should include Ticket ID copy");
  assert.ok(jsonBody.includes("ticket\\s*id\\s*:"), "handoff reply should avoid duplicating ticket id");
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
  assert.ok(names.has("Guardrail Precheck"));
  assert.ok(names.has("Build Knowledge Pack"));
  assert.ok(names.has("Tool Call Placeholders"));
  assert.ok(names.has("CRM Tool Placeholder"));
  assert.ok(names.has("Order Tool Placeholder"));
  assert.ok(names.has("Status Tool Placeholder"));
  assert.ok(names.has("Failed Turn Tracker"));
});

test("workflow contains guided flow router, state, and menu nodes", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  const names = new Set(workflow.nodes.map((node) => node.name));
  const flow = workflow.nodes.find((node) => node.name === "Fetch Guided Flow");
  const router = workflow.nodes.find((node) => node.name === "Guided Flow Router");
  const idempotency = workflow.nodes.find((node) => node.name === "Idempotency & Debounce");
  const guidedReply = workflow.nodes.find((node) => node.name === "Chatwoot Guided Reply");
  const directState = workflow.nodes.find((node) => node.name === "Chatwoot Update Guided State");
  const llmState = workflow.nodes.find((node) => node.name === "Chatwoot Update LLM Guided State");

  assert.ok(names.has("Fetch Guided Flow"));
  assert.ok(names.has("Guided Flow Router"));
  assert.ok(names.has("Guided action is LLM?"));
  assert.ok(names.has("Guided action is handoff?"));
  assert.ok(names.has("Prepare LLM Guided State"));
  assert.ok(flow.parameters.jsCode.includes("guidedFlow"));
  assert.ok(flow.parameters.jsCode.includes("lost_reward_form"));
  assert.ok(flow.parameters.jsCode.includes("withdrawal_menu"));
  assert.ok(flow.parameters.jsCode.includes("Please describe the issue in your own words"));
  assert.ok(router.parameters.jsCode.includes("n8n_guided_flow"));
  assert.ok(router.parameters.jsCode.includes("input_select"));
  assert.ok(router.parameters.jsCode.includes("content_type: 'form'"));
  assert.ok(router.parameters.jsCode.includes("submitted_values"));
  assert.ok(router.parameters.jsCode.includes("flow.nodes"));
  assert.ok(router.parameters.jsCode.includes("enteringFromSelection"));
  assert.ok(router.parameters.jsCode.indexOf("greetingOnly) return renderNode(flow.entry") < router.parameters.jsCode.indexOf("currentNode?.type === 'llm'"));
  assert.ok(!router.parameters.jsCode.includes("faqMap"));
  assert.ok(!router.parameters.jsCode.includes("Reset password"));
  assert.ok(idempotency.parameters.jsCode.includes("isInteractiveSubmission"));
  assert.ok(guidedReply.parameters.jsonBody.includes("guidedMessageBody"));
  assert.ok(directState.parameters.url.includes("/custom_attributes"));
  assert.ok(llmState.parameters.url.includes("/custom_attributes"));
});

test("workflow routes guided custom messages through AI safety path", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  const connections = workflow.connections;

  assert.equal(
    connections["Build Knowledge Pack"].main[0][0].node,
    "Fetch Guided Flow",
  );
  assert.equal(
    connections["Fetch Guided Flow"].main[0][0].node,
    "Guided Flow Router",
  );
  assert.equal(
    connections["Guided action is LLM?"].main[0][0].node,
    "Tool Call Placeholders",
  );
  assert.equal(
    connections["Guided action is handoff?"].main[0][0].node,
    "Failed Turn Tracker",
  );
  assert.equal(connections["Safety Gate"].main[0][0].node, "Failed Turn Tracker");
  assert.equal(
    connections["Failed Turn Tracker"].main[0][0].node,
    "Prepare LLM Guided State",
  );
  assert.equal(
    connections["Prepare LLM Guided State"].main[0][0].node,
    "Chatwoot Update LLM Guided State",
  );
  assert.equal(
    connections["Chatwoot Update LLM Guided State"].main[0][0].node,
    "Action is reply?",
  );
});

test("workflow routes direct guided answers through state update and public reply", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  const connections = workflow.connections;

  assert.equal(
    connections["Guided action is LLM?"].main[1][0].node,
    "Guided action is handoff?",
  );
  assert.equal(
    connections["Guided action is handoff?"].main[1][0].node,
    "Chatwoot Update Guided State",
  );
  assert.equal(
    connections["Chatwoot Update Guided State"].main[0][0].node,
    "Chatwoot Guided Reply",
  );
  assert.equal(
    connections["Chatwoot Guided Reply"].main[0][0].node,
    "Respond OK (guided)",
  );
});

test("guided custom selection prompts for the user question before invoking AI", async () => {
  const workflow = loadWorkflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {},
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "custom",
    isInteractiveSubmission: true,
    interactiveContentType: "input_select",
    submittedValues: [{ title: "Ask a custom question", value: "custom" }],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, "guided_reply");
  assert.equal(routed.nextGuidedState.current_node, "llm");
  assert.equal(routed.nextGuidedState.step, "awaiting_custom");
  assert.match(routed.guidedMessageBody.content, /Please describe the issue/i);
});

test("guided LLM mode resets to menu on greeting or help text", async () => {
  const workflow = loadWorkflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "llm",
        mode: "llm",
        step: "llm_replied",
        path: ["custom"],
        form_data: {},
        llm_turns: 7,
      },
    },
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "hi",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, "guided_reply");
  assert.equal(routed.nextGuidedState.current_node, "main");
  assert.equal(routed.nextGuidedState.mode, "options");
  assert.match(routed.guidedMessageBody.content, /What can I help you with/i);
});

test("guided LLM mode sends actual customer questions to AI", async () => {
  const workflow = loadWorkflow();
  const [{ json: withFlow }] = await runCodeNode(workflow, "Fetch Guided Flow", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "llm",
        mode: "llm",
        step: "awaiting_custom",
        path: ["custom"],
        form_data: {},
        llm_turns: 0,
      },
    },
  });

  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    ...withFlow,
    userText: "My withdrawal is taking too long",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, "llm");
  assert.equal(routed.nextGuidedState.current_node, "llm");
  assert.equal(routed.nextGuidedState.step, "llm_support");
  assert.equal(routed.guidedState.step, "llm_support");
});

test("v3 route context exposes routing metadata and hides control nodes", async () => {
  const workflow = loadV3Workflow();
  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "main",
        mode: "options",
        step: "options",
      },
    },
    guidedFlow: metadataRoutingFlow(),
    userText: "missing reward",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  assert.equal(routed.guidedAction, "llm");
  const targets = routed.routeContext.guided_entry_targets;
  const byId = new Map(targets.map((target) => [target.id, target]));

  assert.equal(byId.get("missing_reward").routing.intent, "missing_reward");
  assert.equal(byId.get("missing_reward").direct, true);
  assert.equal(byId.has("gameissues"), false);
  assert.equal(byId.has("faqCheck_13"), false);
  assert.equal(byId.has("human"), false);
  assert.equal(byId.has("report_shared"), false);
});

test("v3 route context keeps legacy fallback when flow has no routing metadata", async () => {
  const workflow = loadV3Workflow();
  const flow = {
    version: 1,
    entry: "main",
    nodes: {
      main: { type: "options", prompt: "Main", options: [] },
      game_issue_form: { type: "form", prompt: "Game issue", fields: [] },
      faqCheck_13: { type: "faqCheck", prompt: "FAQ", target: "human" },
      human: { type: "human" },
    },
  };
  const [{ json: routed }] = await runCodeNode(workflow, "Guided Flow Router", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "main",
        mode: "options",
        step: "options",
      },
    },
    guidedFlow: flow,
    userText: "game froze",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  const targetIds = Array.from(routed.routeContext.guided_entry_targets, (target) => target.id);
  assert.deepEqual(targetIds, ["game_issue_form"]);
});

test("v3 evaluates direct routing only for explicit routing targets", async () => {
  const workflow = loadV3Workflow();
  const flow = metadataRoutingFlow();
  const [{ json: routed }] = await runEvaluateRagAnswer(workflow, {
    conversationId: 1,
    guidedFlow: flow,
    guidedState: { current_node: "main", path: [], form_data: {} },
    routeContext: {
      guided_entry_targets: [
        {
          id: "missing_reward",
          type: "form",
          direct: true,
          routing: flow.nodes.missing_reward.routing,
          options: [],
        },
      ],
    },
    guardrailRiskFlags: [],
    guardrailLabels: [],
    agentOutput: {
      route: "guided_flow",
      start_node: "missing_reward",
      confidence: 0.9,
      risk_flags: [],
      labels: [],
      knowledge_used: [],
      private_summary: "Route to missing reward",
    },
  });

  assert.equal(routed.guidedAction, "guided_reply");
  assert.equal(routed.nextGuidedState.current_node, "missing_reward");
  assert.match(routed.guidedMessageBody.content, /provide details/i);
});

test("v3 ignores start_option and does not route through parent option nodes", async () => {
  const workflow = loadV3Workflow();
  const flow = metadataRoutingFlow();
  const [{ json: routed }] = await runEvaluateRagAnswer(workflow, {
    conversationId: 1,
    guidedFlow: flow,
    guidedState: { current_node: "main", path: [], form_data: {} },
    routeContext: {
      guided_entry_targets: [
        {
          id: "missing_reward",
          type: "form",
          direct: true,
          routing: flow.nodes.missing_reward.routing,
        },
      ],
    },
    guardrailRiskFlags: [],
    guardrailLabels: [],
    agentOutput: {
      route: "guided_flow",
      start_node: "gameissues",
      start_option: "missing_reward",
      confidence: 0.9,
      risk_flags: [],
      labels: [],
      knowledge_used: [],
      private_summary: "Option route should be ignored",
    },
  });

  assert.equal(routed.guidedAction, "handoff");
  assert.match(routed.privateSummary, /invalid_guided_route=true/);
});

test("v3 rejects silent control nodes unless routing opts in", async () => {
  const workflow = loadV3Workflow();
  const flow = metadataRoutingFlow();
  const [{ json: rejected }] = await runEvaluateRagAnswer(workflow, {
    conversationId: 1,
    guidedFlow: flow,
    guidedState: { current_node: "main", path: [], form_data: {} },
    routeContext: { guided_entry_targets: [{ id: "missing_reward", direct: true }] },
    guardrailRiskFlags: [],
    guardrailLabels: [],
    agentOutput: {
      route: "guided_flow",
      start_node: "faqCheck_13",
      confidence: 0.9,
      risk_flags: [],
      labels: [],
      knowledge_used: [],
      private_summary: "Bad target",
    },
  });

  assert.equal(rejected.guidedAction, "handoff");
  assert.match(rejected.privateSummary, /invalid_guided_route=true/);

  flow.nodes.faqCheck_13.routing = { allowDirectRouting: true, intent: "faq_check" };
  const [{ json: exposed }] = await runCodeNode(workflow, "Guided Flow Router", {
    conversationId: 1,
    customAttributes: {
      n8n_guided_flow: {
        current_node: "main",
        mode: "options",
        step: "options",
      },
    },
    guidedFlow: flow,
    userText: "unknown issue",
    submittedValues: [],
    guardrailRiskFlags: [],
  });

  const faqCheckTarget = exposed.routeContext.guided_entry_targets.find((target) => target.id === "faqCheck_13");
  assert.equal(faqCheckTarget.direct, true);
  assert.equal(faqCheckTarget.routing.intent, "faq_check");
});

test("workflow lets LLM own intent and knowledge selection", () => {
  const raw = readFileSync(join(rootDir, "workflows/chatwoot-support-bot.json"), "utf8");
  const workflow = JSON.parse(raw);
  const guardrail = workflow.nodes.find((node) => node.name === "Guardrail Precheck");
  const knowledge = workflow.nodes.find((node) => node.name === "Build Knowledge Pack");
  const agentInput = workflow.nodes.find((node) => node.name === "Build AI Agent Input");
  const safety = workflow.nodes.find((node) => node.name === "Safety Gate");

  assert.ok(!guardrail.parameters.jsCode.includes("greeting"));
  assert.ok(!guardrail.parameters.jsCode.includes("support_question"));
  assert.ok(!knowledge.parameters.jsCode.includes("score ="));
  assert.ok(knowledge.parameters.jsCode.includes("knowledgePack"));
  assert.ok(agentInput.parameters.jsCode.includes('"intent"'));
  assert.ok(agentInput.parameters.jsCode.includes('"knowledge_used"'));
  assert.ok(!safety.parameters.jsCode.includes("lowKnowledgeMatch"));
  assert.ok(safety.parameters.jsCode.includes("guardrailRiskFlags"));
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

test("validate accepts Chatwoot input_select submission on message_updated", () => {
  const res = validateAgentBotEnvelope(
    {
      headers: { "x-chatwoot-delivery": "delivery-1" },
      body: {
        event: "message_updated",
        id: 270,
        content: "Did this resolve your issue?",
        content_type: "input_select",
        content_attributes: {
          submitted_values: [{ title: "Yes, resolved", value: "resolved_yes" }],
        },
        message_type: "outgoing",
        private: false,
        sender: { id: 2, type: "user" },
        account: { id: 1 },
        conversation: {
          id: 2,
          inbox_id: 3,
          meta: { sender: { id: 44, type: "contact" } },
        },
      },
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.userText, "resolved_yes");
  assert.equal(res.data.isInteractiveSubmission, true);
  assert.equal(res.data.interactiveContentType, "input_select");
  assert.equal(res.data.contactId, 44);
  assert.equal(res.data.messageId, "270:input_select:resolved_yes:delivery-1");
});

test("validate accepts Chatwoot form submission on message_updated", () => {
  const res = validateAgentBotEnvelope(
    {
      headers: { "x-chatwoot-delivery": "delivery-2" },
      body: {
        event: "message_updated",
        id: 280,
        content: "Tell us about the lost reward.",
        content_type: "form",
        content_attributes: {
          submitted_values: [{ name: "lost_location", value: "Tournament screen" }],
        },
        message_type: "outgoing",
        private: false,
        sender: { id: 2, type: "user" },
        account: { id: 1 },
        conversation: {
          id: 2,
          inbox_id: 3,
          meta: { sender: { id: 44, type: "contact" } },
        },
      },
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.userText, '{"lost_location":"Tournament screen"}');
  assert.equal(res.data.isInteractiveSubmission, true);
  assert.equal(res.data.interactiveContentType, "form");
  assert.deepEqual(res.data.submittedValues, [{ name: "lost_location", value: "Tournament screen" }]);
  assert.equal(res.data.messageId, '280:form:{"lost_location":"Tournament screen"}:delivery-2');
});

test("validate preserves Chatwoot message attachments", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_created",
        id: 301,
        content: "",
        message_type: "incoming",
        attachments: [
          {
            id: 9,
            file_type: "image",
            file_name: "receipt.png",
            data_url: "https://example.test/receipt.png",
          },
        ],
        sender: { id: 44, type: "contact" },
        account: { id: 1 },
        conversation: { id: 2, inbox_id: 3 },
      },
      headers: {},
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.hasAttachments, true);
  assert.equal(res.data.attachments[0].file_name, "receipt.png");
});

test("validate rejects non-selection message_updated events", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        event: "message_updated",
        id: 270,
        content: "Menu changed status",
        content_type: "input_select",
        content_attributes: { items: [{ title: "Status", value: "status" }] },
        message_type: "outgoing",
        private: false,
        sender: { id: 2, type: "user" },
        account: { id: 1 },
        conversation: { id: 2, inbox_id: 3 },
      },
    },
    {},
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unsupported_event");
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

test("validate accepts actual Chatwoot payload with sender type nested in conversation message", () => {
  const res = validateAgentBotEnvelope(
    {
      body: {
        account: { id: 2, name: "Mindstormstudios" },
        content: "hi",
        conversation: {
          id: 1,
          inbox_id: 1,
          messages: [
            {
              id: 166,
              content: "hi",
              message_type: 0,
              private: false,
              sender_type: "Contact",
              sender_id: 1,
              sender: { id: 1, name: "purple-thunder-157", type: "contact" },
            },
          ],
          meta: {
            sender: { id: 1, name: "purple-thunder-157", type: "contact" },
          },
          contact_inbox: { contact_id: 1 },
        },
        id: 166,
        inbox: { id: 1, name: "ProGolf Support" },
        message_type: "incoming",
        private: false,
        sender: { id: 1, name: "purple-thunder-157" },
        event: "message_created",
      },
      headers: {},
    },
    {},
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.accountId, 2);
  assert.equal(res.data.conversationId, 1);
  assert.equal(res.data.messageId, 166);
  assert.equal(res.data.userText, "hi");
  assert.equal(res.data.contactId, 1);
  assert.equal(res.data.senderType, "contact");
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

test("safety hands off low confidence", () => {
  const out = evaluateSafety({
    agent: {
      answer: "ok",
      confidence: 0.69,
      needs_human: false,
      risk_flags: [],
      labels: [],
      private_summary: "x",
    },
    upstream: { accountId: 1 },
    httpError: false,
  });
  assert.equal(out.action, "handoff");
});

test("safety allows confident greeting without knowledge", () => {
  const out = evaluateSafety({
    agent: {
      intent: "greeting",
      answer: "Hey! How can I help you today?",
      confidence: 0.9,
      needs_human: false,
      risk_flags: [],
      knowledge_used: [],
      labels: [],
      private_summary: "Greeting handled.",
    },
    upstream: { accountId: 1 },
    httpError: false,
  });
  assert.equal(out.action, "reply");
  assert.equal(out.intent, "greeting");
  assert.deepEqual(out.knowledgeUsed, []);
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

test("safety hands off on risk flag", () => {
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
  assert.equal(out.action, "handoff");
});

test("safety hands off missing or too long answer", () => {
  assert.equal(
    evaluateSafety({
      agent: { answer: "", confidence: 0.99, needs_human: false, risk_flags: [] },
      upstream: {},
      httpError: false,
    }).action,
    "handoff",
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
    "handoff",
  );
});

test("safety hands off on tool failure", () => {
  const out = evaluateSafety({ agent: null, upstream: {}, httpError: true });
  assert.equal(out.action, "handoff");
  assert.match(out.privateSummary, /tool_failed/);
});

test("failure state hands off after two failed turns and resets on reply", () => {
  const first = nextFailureState({
    conversationId: 12,
    previous: {},
    safety: { action: "handoff", confidence: 0.2 },
  });
  assert.equal(first.forceHandoff, false);

  const second = nextFailureState({
    conversationId: 12,
    previous: first.counts,
    safety: { action: "handoff", confidence: 0.2 },
  });
  assert.equal(second.forceHandoff, true);

  const reset = nextFailureState({
    conversationId: 12,
    previous: second.counts,
    safety: { action: "reply", confidence: 0.9 },
  });
  assert.equal(reset.failedTurnCount, 0);
});
