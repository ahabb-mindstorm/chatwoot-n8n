import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { patchWorkflow } from "../scripts/patch-typing-indicators.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadFixture() {
  const raw = readFileSync(
    join(rootDir, "tests/fixtures/progolf-support-bot-v2-pre-typing.json"),
    "utf8",
  );
  return JSON.parse(raw);
}

function nodeByName(workflow, name) {
  return workflow.nodes.find((node) => node.name === name);
}

function mainTargets(workflow, sourceName, outputIndex = 0) {
  const outputs = workflow.connections[sourceName]?.main?.[outputIndex] || [];
  return outputs.map((target) => target.node);
}

test("patch adds typing nodes with toggle_typing_status URL and non-blocking settings", () => {
  const workflow = patchWorkflow(loadFixture());
  const typingOn = nodeByName(workflow, "Typing On");
  assert.ok(typingOn, "Typing On node exists");
  assert.equal(typingOn.type, "n8n-nodes-base.httpRequest");
  assert.equal(typingOn.onError, "continueRegularOutput");
  assert.equal(typingOn.alwaysOutputData, true);
  assert.match(typingOn.parameters.url, /toggle_typing_status/);
  assert.match(typingOn.parameters.jsonBody, /typing_status: 'on'/);

  for (const name of ["Typing Off Before Reply", "Typing Off Before Form", "Typing Off Before Notify"]) {
    const node = nodeByName(workflow, name);
    assert.ok(node, `${name} exists`);
    assert.match(node.parameters.jsonBody, /typing_status: 'off'/);
    assert.equal(node.parameters.options?.timeout, 5000);
  }
});

test("patch wires typing on between Route Event user_message and Support Agent", () => {
  const workflow = patchWorkflow(loadFixture());
  assert.deepEqual(mainTargets(workflow, "Route Event", 0), ["Typing Indicators Enabled?"]);
  assert.deepEqual(mainTargets(workflow, "Typing Indicators Enabled?", 0), ["Wait Before Typing"]);
  assert.deepEqual(mainTargets(workflow, "Wait Before Typing"), ["Typing On"]);
  assert.deepEqual(mainTargets(workflow, "Typing On"), ["Support Agent"]);
  assert.deepEqual(mainTargets(workflow, "Typing Indicators Enabled?", 1), ["Support Agent"]);
});

test("patch wires typing off before public outbound messages", () => {
  const workflow = patchWorkflow(loadFixture());
  assert.deepEqual(mainTargets(workflow, "Route Requirement Lookup", 0), ["Typing Off Before Reply"]);
  assert.deepEqual(mainTargets(workflow, "Typing Off Before Reply"), ["Send Reply"]);
  assert.deepEqual(mainTargets(workflow, "Route Saved Escalation", 0), ["Typing Off Before Form"]);
  assert.deepEqual(mainTargets(workflow, "Typing Off Before Form"), ["Send Escalation Form"]);
  assert.deepEqual(mainTargets(workflow, "Prepare Handoff"), ["Post Internal Note"]);
  assert.deepEqual(mainTargets(workflow, "Label Conversation"), ["Typing Off Before Notify"]);
  assert.deepEqual(mainTargets(workflow, "Typing Off Before Notify"), ["Notify Player"]);
});

test("patch preserves form_submitted handoff route", () => {
  const workflow = patchWorkflow(loadFixture());
  assert.deepEqual(mainTargets(workflow, "Route Event", 1), ["Prepare Handoff"]);
});

test("Typing Indicators Enabled? respects CHATWOOT_TYPING_INDICATORS default true", () => {
  const workflow = patchWorkflow(loadFixture());
  const gate = nodeByName(workflow, "Typing Indicators Enabled?");
  const condition = gate.parameters.conditions.conditions[0];
  assert.match(condition.leftValue, /CHATWOOT_TYPING_INDICATORS/);
  assert.equal(condition.rightValue, "false");
  assert.equal(condition.operator.operation, "notEquals");
});
