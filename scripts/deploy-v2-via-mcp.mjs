import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const workflowId = process.env.WORKFLOW_ID || "GcKbOSy3k8hqfqIr";

const mcp = JSON.parse(readFileSync(join(homedir(), ".cursor/mcp.json"), "utf8"));
const code = readFileSync(join(root, "workflows/progolf-support-bot-v2-pgvector.sdk.js"), "utf8");
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text.slice(0, 500)}`);
  const payload = JSON.parse(dataLine.slice(6));
  const structured = payload.result?.structuredContent || JSON.parse(payload.result?.content?.[0]?.text || "{}");
  if (payload.result?.isError) {
    throw new Error(JSON.stringify(structured));
  }
  return structured;
}

const validated = await callTool("validate_workflow", { code });
if (!validated.valid) {
  throw new Error(`Workflow SDK validation failed: ${JSON.stringify(validated.errors || validated)}`);
}

const updated = await callTool("update_workflow", {
  workflowId,
  description: "ProGolf support bot with signed Chatwoot webhook verification, durable debounce/idempotency, Postgres memory, and PGVector RAG.",
  code,
});

console.log(`Updated workflow ${updated.workflowId} (${updated.name}) with ${updated.nodeCount} nodes`);
console.log(updated.url);

const published = await callTool("publish_workflow", { workflowId });
if (!published.success) {
  throw new Error(`Workflow publish failed: ${JSON.stringify(published)}`);
}
console.log(`Published active version ${published.activeVersionId}`);
