import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "workflows/progolf-support-bot-v2-pgvector.sdk.js",
  "workflows/get-escalation-requirements.sdk.js",
  "workflows/progolf-bot-error-alert.sdk.js",
];

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

for (const file of files) {
  const code = readFileSync(join(root, file), "utf8");
  const result = await callTool("validate_workflow", { code });
  if (!result.valid) {
    throw new Error(`${file} failed SDK validation: ${JSON.stringify(result.errors || result)}`);
  }
  console.log(`Validated ${file}: ${result.workflow?.nodes?.length ?? result.nodeCount ?? "unknown"} nodes`);
}
