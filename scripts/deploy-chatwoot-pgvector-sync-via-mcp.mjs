import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_ID = "aKWMvcvtHB0pU62B";
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const code = readFileSync(join(root, "workflows/progolf-chatwoot-faq-to-pgvector-sync.sdk.js"), "utf8");
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

const validated = await callTool("validate_workflow", { code, i: "Validate Chatwoot pgvector sync" });
if (!validated.valid) {
  throw new Error(`Workflow SDK validation failed: ${JSON.stringify(validated.errors || validated)}`);
}

const updated = await callTool("update_workflow", {
  workflowId: WORKFLOW_ID,
  code,
  description:
    "Sync published Chatwoot Help Center articles (via API) into progolf_support.progolf_faq_vectors with scoped delete + OpenAI embeddings.",
  i: "Update Chatwoot pgvector sync workflow",
});

console.log(`Updated workflow ${updated.workflowId} (${updated.name}) with ${updated.nodeCount} nodes`);
console.log(updated.url);
