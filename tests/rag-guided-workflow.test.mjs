import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

import {
  applyGuidedInput,
  buildNextGuidedState,
  evaluatePlanScope,
  parseFlowPlan,
  renderGuidedMessage,
} from "../lib/flowPlanner.mjs";
import { evaluateRetrieval, normalizeRetrievedChunks } from "../lib/ragScope.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadRagWorkflow() {
  const raw = readFileSync(
    join(rootDir, "workflows/chatwoot-rag-guided-bot.json"),
    "utf8",
  );
  return JSON.parse(raw);
}

test("rag workflow JSON parses", () => {
  loadRagWorkflow();
});

test("rag workflow Code node JavaScript compiles", () => {
  const workflow = loadRagWorkflow();
  for (const node of workflow.nodes) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    assert.doesNotThrow(
      () => new vm.Script(`(async () => {\n${code}\n})()`),
      `${node.name} should compile`,
    );
  }
});

test("rag workflow routes Guardrail through RAG planner to reply or handoff", () => {
  const workflow = loadRagWorkflow();
  const connections = workflow.connections;

  assert.equal(
    connections["Guardrail Precheck"].main[0][0].node,
    "Merge Guided State",
  );
  assert.equal(
    connections["Merge Guided State"].main[0][0].node,
    "Pinecone Vector Store",
  );
  assert.equal(
    connections["Pinecone Vector Store"].main[0][0].node,
    "Build RAG Context",
  );
  assert.equal(
    connections["Scope and Safety Gate"].main[0][0].node,
    "Failed Turn Tracker",
  );
  assert.equal(
    connections["Action is reply?"].main[0][0].node,
    "Chatwoot RAG Guided Reply",
  );
  assert.equal(
    connections["Action is reply?"].main[1][0].node,
    "Chatwoot Add Labels",
  );
});

test("rag workflow contains RAG and Flow Planner nodes", () => {
  const workflow = loadRagWorkflow();
  const names = new Set(workflow.nodes.map((node) => node.name));
  const types = new Set(workflow.nodes.map((node) => node.type));

  assert.ok(names.has("Pinecone Vector Store"));
  assert.ok(names.has("Embeddings OpenAI"));
  assert.ok(names.has("Flow Planner Agent"));
  assert.ok(names.has("Scope and Safety Gate"));
  assert.ok(names.has("Merge Guided State"));
  assert.ok(types.has("@n8n/n8n-nodes-langchain.vectorStorePinecone"));
  assert.equal(workflow.nodes.find((n) => n.type === "n8n-nodes-base.webhook").parameters.path, "chatwoot-rag-guided-bot");
});

test("evaluateRetrieval marks in-scope when max score meets threshold", () => {
  const out = evaluateRetrieval({
    chunks: [
      { id: "a", score: 0.81 },
      { id: "b", score: 0.75 },
    ],
    minScore: 0.72,
  });
  assert.equal(out.inScope, true);
  assert.equal(out.maxScore, 0.81);
  assert.deepEqual(out.chunkIds, ["a", "b"]);
});

test("evaluateRetrieval marks out-of-scope when empty or low score", () => {
  assert.equal(evaluateRetrieval({ chunks: [], minScore: 0.72 }).inScope, false);
  assert.equal(
    evaluateRetrieval({ chunks: [{ id: "x", score: 0.5 }], minScore: 0.72 }).inScope,
    false,
  );
});

test("normalizeRetrievedChunks maps pinecone-like documents", () => {
  const chunks = normalizeRetrievedChunks([
    {
      json: {
        score: 0.9,
        document: {
          pageContent: "Check reward inbox",
          metadata: {
            doc_id: "lost-reward-overview",
            topic: "lost_reward",
            game_contexts: ["main_screen", "tournament"],
            tips: ["Force-close app"],
          },
        },
      },
    },
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "lost-reward-overview");
  assert.equal(chunks[0].topic, "lost_reward");
  assert.deepEqual(chunks[0].game_contexts, ["main_screen", "tournament"]);
});

test("parseFlowPlan parses strict JSON and strips fences", () => {
  const fenced = parseFlowPlan('```json\n{"in_scope":true,"step_type":"options"}\n```');
  assert.equal(fenced.parseFailed, false);
  assert.equal(fenced.plan.step_type, "options");
});

test("evaluatePlanScope hands off when retrieval out of scope", () => {
  const out = evaluatePlanScope({
    plan: {
      in_scope: true,
      step_type: "options",
      confidence: 0.9,
      prompt: "Where?",
      options: [{ id: "main_screen", text: "Main screen" }],
    },
    retrieval: { inScope: false, maxScore: 0.4 },
  });
  assert.equal(out.action, "handoff");
  assert.ok(out.riskFlags.includes("out_of_knowledge"));
});

test("evaluatePlanScope hands off when planner says out of scope", () => {
  const out = evaluatePlanScope({
    plan: { in_scope: false, confidence: 0.2, step_type: "handoff" },
    retrieval: { inScope: true, maxScore: 0.9 },
  });
  assert.equal(out.action, "handoff");
});

test("evaluatePlanScope allows guided_reply for lost reward options", () => {
  const out = evaluatePlanScope({
    plan: {
      in_scope: true,
      topic: "lost_reward",
      step_type: "options",
      prompt: "Where did you lose the reward?",
      options: [
        { id: "main_screen", text: "Main screen" },
        { id: "tournament", text: "Tournament" },
      ],
      tips: ["Check inbox"],
      confidence: 0.88,
      needs_human: false,
      knowledge_used: ["lost-reward-overview"],
    },
    retrieval: { inScope: true, maxScore: 0.85 },
  });
  assert.equal(out.action, "guided_reply");
  assert.equal(out.guidedAction, "guided_reply");
});

test("renderGuidedMessage builds input_select with tips", () => {
  const body = renderGuidedMessage({
    plan: {
      step_type: "options",
      prompt: "Where did you lose the reward?",
      options: [
        { id: "main_screen", text: "Main screen" },
        { id: "tournament", text: "Tournament" },
      ],
      tips: ["Check reward inbox"],
    },
  });
  assert.equal(body.content_type, "input_select");
  assert.equal(body.content_attributes.items.length, 2);
  assert.match(body.content, /Quick tips/);
  assert.equal(body.content_attributes.items[0].value, "main_screen");
  assert.equal(body.content_attributes.items[1].title, "Tournament");
});

test("applyGuidedInput appends option selection to path", () => {
  const state = applyGuidedInput(
    { topic: "lost_reward", path: ["lost_reward"], slots: {} },
    {
      isInteractiveSubmission: true,
      interactiveContentType: "input_select",
      submittedValues: [{ value: "tournament" }],
    },
  );
  assert.deepEqual(state.path, ["lost_reward", "tournament"]);
  assert.equal(state.slots.last_selection, "tournament");
});

test("buildNextGuidedState preserves topic and increments turns", () => {
  const next = buildNextGuidedState({
    plan: { topic: "lost_reward", step_type: "options" },
    guidedState: { path: ["lost_reward"], llm_turns: 1 },
  });
  assert.equal(next.topic, "lost_reward");
  assert.equal(next.llm_turns, 2);
  assert.equal(next.mode, "rag_guided");
});
