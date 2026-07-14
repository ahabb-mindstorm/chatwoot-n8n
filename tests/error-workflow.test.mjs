import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = readFileSync(join(root, "workflows/progolf-bot-error-alert.sdk.js"), "utf8");
const startMarker = "const shapeSlackErrorJsCode = `";
const endMarker = "`;\n\nconst workflowError";
const start = sdk.indexOf(startMarker);
const end = sdk.indexOf(endMarker, start);

assert.ok(start >= 0 && end > start, "Slack error shaper source exists");
const rawShapeCode = sdk.slice(start + startMarker.length, end);
const shapeCode = new vm.Script(`\`${rawShapeCode}\``).runInNewContext();

async function shape(payload) {
  const script = new vm.Script(`(async () => {\n${shapeCode}\n})()`);
  return script.runInNewContext({
    $input: { first: () => ({ json: payload }) },
  });
}

test("error workflow is defensive and posts only the shaped Slack body", () => {
  assert.match(sdk, /n8n-nodes-base\.errorTrigger/);
  assert.match(sdk, /url: '=\{\{ \$env\.SLACK_ALERT_WEBHOOK_URL \}\}'/);
  assert.match(sdk, /JSON\.stringify\(\{ text: \$json\.text \}\)/);
  assert.match(sdk, /timeout: 8000/);
  assert.match(sdk, /retryOnFail: \{\s+maxTries: 2,\s+waitBetweenTries: 1500,/);
  assert.match(sdk, /workflow\(WORKFLOW_ID, WORKFLOW_NAME\)/);
});

test("normal execution errors are compact, escaped, and omit payloads and stacks", async () => {
  const [{ json }] = await shape({
    workflow: { id: "wf-1", name: "Main <Bot>" },
    execution: {
      id: "exec-1",
      mode: "webhook",
      url: "https://n8n.example.com/execution/exec-1",
      lastNodeExecuted: "Suppress Disabled Event",
      error: {
        name: "DatabaseError",
        message: "database <failed>",
        stack: "TOP SECRET STACK",
      },
    },
    password: "DO NOT LEAK",
    inputData: { email: "player@example.com" },
  });

  assert.match(json.text, /Main &lt;Bot&gt;/);
  assert.match(json.text, /DatabaseError: database &lt;failed&gt;/);
  assert.match(json.text, /Suppress Disabled Event/);
  assert.match(json.text, /https:\/\/n8n\.example\.com\/execution\/exec-1/);
  assert.doesNotMatch(json.text, /TOP SECRET STACK|DO NOT LEAK|player@example\.com/);
  assert.equal(json.workflowId, "wf-1");
  assert.equal(json.executionId, "exec-1");
});

test("trigger-level errors and safe conversation identifiers are shaped without throwing", async () => {
  const [{ json }] = await shape({
    workflow: { id: "wf-2", name: "Escalation lookup" },
    trigger: {
      mode: "trigger",
      error: {
        name: "TriggerError",
        message: "",
        cause: {
          message: "Trigger could not start",
          stack: "PRIVATE STACK",
          node: { name: "Escalation Requirements Input" },
        },
      },
    },
    context: { conversationId: "conversation_595" },
  });

  assert.match(json.text, /TriggerError: Trigger could not start/);
  assert.match(json.text, /Escalation Requirements Input/);
  assert.match(json.text, /Conversation:\* conversation_595/);
  assert.doesNotMatch(json.text, /PRIVATE STACK/);
  assert.equal(json.conversationId, "conversation_595");
});

test("unsafe conversation values and execution URLs are omitted", async () => {
  const [{ json }] = await shape({
    workflow: { id: "wf-3", name: "Main" },
    execution: {
      id: "exec-3",
      url: "javascript:alert(1)",
      error: { message: "failed" },
    },
    context: { conversationId: "595\n<!channel>" },
  });

  assert.equal(json.conversationId, null);
  assert.doesNotMatch(json.text, /javascript:|Conversation:/);
});
