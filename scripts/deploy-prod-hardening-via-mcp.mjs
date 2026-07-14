import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainWorkflowId = process.env.WORKFLOW_ID || "GcKbOSy3k8hqfqIr";
const escalationWorkflowId = process.env.ESCALATION_WORKFLOW_ID || "YD4d0AAkcvOSSLua";
const existingErrorWorkflowId = process.env.ERROR_WORKFLOW_ID || "";

const workflows = {
  main: {
    id: mainWorkflowId,
    name: "ProGolf Support Bot (v2) Postgres Memory PGVector RAG",
    description: "ProGolf support bot with signed Chatwoot webhooks, durable debounce/idempotency, Postgres memory, PGVector RAG, bounded Chatwoot requests, and production error alerting.",
    code: readFileSync(join(root, "workflows/progolf-support-bot-v2-pgvector.sdk.js"), "utf8"),
  },
  escalation: {
    id: escalationWorkflowId,
    name: "Get Escalation Requirements",
    description: "Returns canonical escalation fields and attachment guidance for each ProGolf support category, including player reports.",
    code: readFileSync(join(root, "workflows/get-escalation-requirements.sdk.js"), "utf8"),
  },
  error: {
    id: existingErrorWorkflowId,
    name: "ProGolf Bot Error Alerts",
    description: "Shapes failed n8n execution metadata into a compact defensive Slack alert without including stacks or full execution payloads.",
    code: readFileSync(join(root, "workflows/progolf-bot-error-alert.sdk.js"), "utf8"),
  },
};

const mcp = JSON.parse(readFileSync(join(homedir(), ".cursor/mcp.json"), "utf8"));
const url = mcp.mcpServers?.["n8n-mcp"]?.url;
const auth = mcp.mcpServers?.["n8n-mcp"]?.headers?.Authorization;

if (!url || !auth) {
  throw new Error("n8n MCP is not configured in ~/.cursor/mcp.json");
}

async function callTool(name, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text.slice(0, 500)}`);
  const payload = JSON.parse(dataLine.slice(6));
  const structured = payload.result?.structuredContent
    || JSON.parse(payload.result?.content?.[0]?.text || "{}");
  if (payload.result?.isError) throw new Error(JSON.stringify(structured));
  return structured;
}

async function validate(definition) {
  const result = await callTool("validate_workflow", { code: definition.code });
  if (!result.valid) {
    throw new Error(`${definition.name} failed validation: ${JSON.stringify(result.errors || result)}`);
  }
}

async function updateAndPublish(definition) {
  await callTool("update_workflow", {
    workflowId: definition.id,
    name: definition.name,
    description: definition.description,
    code: definition.code,
  });
  await callTool("publish_workflow", { workflowId: definition.id });
  return definition.id;
}

async function createOrUpdateErrorWorkflow() {
  if (workflows.error.id) {
    return updateAndPublish(workflows.error);
  }

  const created = await callTool("create_workflow_from_code", {
    name: workflows.error.name,
    description: workflows.error.description,
    code: workflows.error.code,
  });
  const workflowId = created.workflowId || created.id;
  if (!workflowId) throw new Error(`Error workflow creation did not return an ID: ${JSON.stringify(created)}`);
  await callTool("publish_workflow", { workflowId });
  return workflowId;
}

function workflowRecord(details) {
  return details.workflow || details;
}

for (const definition of Object.values(workflows)) {
  await validate(definition);
}

await updateAndPublish(workflows.escalation);
const errorWorkflowId = await createOrUpdateErrorWorkflow();
await updateAndPublish(workflows.main);

const escalation = workflowRecord(await callTool("get_workflow_details", {
  workflowId: workflows.escalation.id,
}));
const error = workflowRecord(await callTool("get_workflow_details", {
  workflowId: errorWorkflowId,
}));
const main = workflowRecord(await callTool("get_workflow_details", {
  workflowId: workflows.main.id,
}));

for (const [label, item] of [
  ["escalation", escalation],
  ["error", error],
  ["main", main],
]) {
  if (!item.versionId || item.activeVersionId !== item.versionId) {
    throw new Error(`${label} workflow draft is not the active version`);
  }
}
if (escalation.name !== workflows.escalation.name) {
  throw new Error(`Escalation workflow has unexpected name: ${escalation.name}`);
}
if (error.name !== workflows.error.name) {
  throw new Error(`Error workflow has unexpected name: ${error.name}`);
}

console.log(JSON.stringify({
  escalation: {
    workflowId: workflows.escalation.id,
    name: escalation.name,
    versionId: escalation.versionId,
    activeVersionId: escalation.activeVersionId,
  },
  error: {
    workflowId: errorWorkflowId,
    name: error.name,
    versionId: error.versionId,
    activeVersionId: error.activeVersionId,
  },
  main: {
    workflowId: workflows.main.id,
    name: main.name,
    versionId: main.versionId,
    activeVersionId: main.activeVersionId,
  },
}, null, 2));
