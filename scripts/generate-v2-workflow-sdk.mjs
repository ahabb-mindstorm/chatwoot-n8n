import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchWorkflow } from "./patch-typing-indicators.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const inputPath = process.argv[2] || join(root, "workflows/progolf-support-bot-v2-pgvector.json");
const outputPath = process.argv[3] || join(root, "workflows/progolf-support-bot-v2-pgvector.sdk.js");

const sourceWorkflow = JSON.parse(readFileSync(inputPath, "utf8"));
const workflow = sourceWorkflow.nodes.some((node) => node.name === "Ingest Durable Event")
  ? sourceWorkflow
  : patchWorkflow(sourceWorkflow);

function toVar(name) {
  const base = name.replace(/[^a-zA-Z0-9]+/g, " ").trim()
    .split(" ")
    .map((part, index) => (index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
  return /^[a-zA-Z_$]/.test(base) ? base : `node_${base}`;
}

function escapeString(value) {
  return JSON.stringify(value);
}

function serializeValue(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${pad}  ${serializeValue(item, indent + 2)}`).join(",\n")}\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([key, val]) => `${pad}  ${JSON.stringify(key)}: ${serializeValue(val, indent + 2)}`).join(",\n")}\n${pad}}`;
}

function nodeFactory(type) {
  if (type === "n8n-nodes-base.webhook" || type === "n8n-nodes-base.scheduleTrigger") return "trigger";
  if (type === "n8n-nodes-base.if") return "ifElse";
  if (type === "n8n-nodes-base.switch") return "switchCase";
  if (type.includes("lmChatOpenAi")) return "languageModel";
  if (type.includes("outputParserStructured")) return "outputParser";
  if (type.includes("embeddingsOpenAi")) return "embeddings";
  if (type.includes("memoryPostgresChat")) return "memory";
  if (type.includes("toolWorkflow") || type.includes("toolCode")) return "tool";
  return "node";
}

function buildSubnodes(nodeName, workflowJson) {
  const subnodes = {};
  for (const [sourceName, connection] of Object.entries(workflowJson.connections)) {
    for (const [connType, outputs] of Object.entries(connection)) {
      if (!connType.startsWith("ai_")) continue;
      for (const output of outputs) {
        for (const target of output) {
          if (target.node !== nodeName) continue;
          const key = connType.replace(/^ai_/, "");
          const mapped = key === "languageModel" ? "model"
            : key === "outputParser" ? "outputParser"
            : key === "embedding" ? "embedding"
            : key === "memory" ? "memory"
            : key === "tool" ? "tools"
            : key;
          if (mapped === "tools") {
            subnodes.tools = subnodes.tools || [];
            subnodes.tools.push(toVar(sourceName));
          } else {
            subnodes[mapped] = toVar(sourceName);
          }
        }
      }
    }
  }
  return subnodes;
}

const varByName = new Map();
for (const node of workflow.nodes) {
  varByName.set(node.name, toVar(node.name));
}

const lines = [];
lines.push("import { workflow, node, trigger, ifElse, switchCase, languageModel, memory, tool, outputParser, embeddings, newCredential } from '@n8n/workflow-sdk';");
lines.push("");
lines.push(`const WORKFLOW_ID = 'GcKbOSy3k8hqfqIr';`);
lines.push(`const WORKFLOW_NAME = ${escapeString(workflow.name)};`);
lines.push("");

const nodeOrder = [...workflow.nodes];
const deps = new Map();
for (const node of nodeOrder) deps.set(node.name, new Set());
for (const [sourceName, connection] of Object.entries(workflow.connections)) {
  for (const [connType, outputs] of Object.entries(connection)) {
    if (!connType.startsWith("ai_")) continue;
    for (const output of outputs) {
      for (const target of output) deps.get(target.node)?.add(sourceName);
    }
  }
}
const sorted = [];
const pending = [...nodeOrder];
while (pending.length > 0) {
  const nextIndex = pending.findIndex((node) => {
    for (const dep of deps.get(node.name) || []) {
      if (!sorted.some((done) => done.name === dep)) return false;
    }
    return true;
  });
  if (nextIndex === -1) {
    sorted.push(...pending);
    break;
  }
  sorted.push(pending.splice(nextIndex, 1)[0]);
}
nodeOrder.splice(0, nodeOrder.length, ...sorted);

for (const item of nodeOrder) {
  const varName = varByName.get(item.name);
  const factory = nodeFactory(item.type);

  const subnodeEntries = buildSubnodes(item.name, workflow);
  const subnodeLines = [];
  if (Object.keys(subnodeEntries).length > 0) {
    subnodeLines.push("    subnodes: {");
    for (const [key, value] of Object.entries(subnodeEntries)) {
      if (key === "tools") {
        subnodeLines.push(`      tools: [${value.join(", ")}],`);
      } else {
        subnodeLines.push(`      ${key}: ${value},`);
      }
    }
    subnodeLines.push("    },");
  }

  const credentialLines = [];
  if (item.credentials) {
    credentialLines.push("    credentials: {");
    for (const [credType, cred] of Object.entries(item.credentials)) {
      credentialLines.push(`      ${JSON.stringify(credType)}: newCredential(${escapeString(cred.name || credType)}),`);
    }
    credentialLines.push("    },");
  }

  if (factory === "trigger") {
    lines.push(`const ${varName} = trigger({`);
  } else if (factory === "ifElse") {
    lines.push(`const ${varName} = ifElse({`);
  } else if (factory === "switchCase") {
    lines.push(`const ${varName} = switchCase({`);
  } else if (factory === "languageModel") {
    lines.push(`const ${varName} = languageModel({`);
  } else if (factory === "outputParser") {
    lines.push(`const ${varName} = outputParser({`);
  } else if (factory === "embeddings") {
    lines.push(`const ${varName} = embeddings({`);
  } else if (factory === "memory") {
    lines.push(`const ${varName} = memory({`);
  } else if (factory === "tool") {
    lines.push(`const ${varName} = tool({`);
  } else {
    lines.push(`const ${varName} = node({`);
  }

  lines.push(`  type: ${escapeString(item.type)},`);
  lines.push(`  version: ${item.typeVersion},`);
  lines.push("  config: {");
  lines.push(`    name: ${escapeString(item.name)},`);
  lines.push(`    parameters: ${serializeValue(item.parameters || {}, 4)},`);
  lines.push(`    position: ${serializeValue(item.position || [0, 0])},`);
  if (item.onError) lines.push(`    onError: ${escapeString(item.onError)},`);
  if (item.alwaysOutputData) lines.push("    alwaysOutputData: true,");
  if (item.retryOnFail && (item.maxTries !== undefined || item.waitBetweenTries !== undefined)) {
    lines.push("    retryOnFail: {");
    if (item.maxTries !== undefined) lines.push(`      maxTries: ${item.maxTries},`);
    if (item.waitBetweenTries !== undefined) lines.push(`      waitBetweenTries: ${item.waitBetweenTries},`);
    lines.push("    },");
  } else if (item.retryOnFail) {
    lines.push("    retryOnFail: true,");
  }
  if (item.notesInFlow) lines.push("    notesInFlow: true,");
  if (item.notes) lines.push(`    notes: ${escapeString(item.notes)},`);
  if (item.id) lines.push(`    id: ${escapeString(item.id)},`);
  for (const line of subnodeLines) lines.push(line);
  for (const line of credentialLines) lines.push(line);
  lines.push("  },");
  lines.push(`  output: [{}],`);
  lines.push(`});`);
  lines.push("");
}

function chainFrom(nodeName, outputIndex = 0, stopNodes = new Set()) {
  const varName = varByName.get(nodeName);
  const nodeDef = workflow.nodes.find((n) => n.name === nodeName);
  const outs = workflow.connections[nodeName]?.main?.[outputIndex] || [];
  if (outs.length === 0) return varName;

  const targetName = outs[0].node;
  if (stopNodes.has(targetName)) return varName;
  const targetDef = workflow.nodes.find((n) => n.name === targetName);
  const targetVar = varByName.get(targetName);

  if (nodeDef?.type === "n8n-nodes-base.if") {
    const falseTarget = workflow.connections[nodeName]?.main?.[1]?.[0]?.node;
    const trueChain = chainFrom(targetName, 0, stopNodes);
    const falseChain = falseTarget ? chainFrom(falseTarget, 0, stopNodes) : null;
    return `${varName}.onTrue(${trueChain})${falseChain ? `.onFalse(${falseChain})` : ""}`;
  }

  if (nodeDef?.type === "n8n-nodes-base.switch") {
    const cases = workflow.connections[nodeName]?.main || [];
    const parts = cases.map((caseTargets, index) => {
      if (!caseTargets?.[0]?.node) return null;
      return `.onCase(${index}, ${chainFrom(caseTargets[0].node, 0, stopNodes)})`;
    }).filter(Boolean);
    return `${varName}${parts.join("")}`;
  }

  if (nodeDef?.onError === "continueErrorOutput") {
    const successTarget = workflow.connections[nodeName]?.main?.[0]?.[0]?.node;
    const successChain = successTarget ? chainFrom(successTarget, 0, stopNodes) : null;
    let expr = varName;
    if (successChain && successChain !== varName) expr += `.to(${successChain})`;
    return expr;
  }

  const rest = chainFrom(targetName, 0, stopNodes);
  if (rest === targetVar) return `${varName}.to(${targetVar})`;
  return `${varName}.to(${rest})`;
}

const webhookChain = chainFrom("Chatwoot Bot Events");
lines.push(`export default workflow(WORKFLOW_ID, WORKFLOW_NAME)`);
lines.push(`  .add(${webhookChain})`);
for (const triggerName of ["Recovery Schedule", "Cleanup Schedule"]) {
  if (varByName.has(triggerName)) lines.push(`  .add(${chainFrom(triggerName)})`);
}
if (varByName.has("Support Agent") && varByName.has("Code in JavaScript")) {
  lines.push(`  .add(${varByName.get("Support Agent")}.output(1).to(${chainFrom("Code in JavaScript")}))`);
}
lines[lines.length - 1] = `${lines[lines.length - 1]};`;

writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${outputPath}`);
