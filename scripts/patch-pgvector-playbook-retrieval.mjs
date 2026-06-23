const DEFAULT_WORKFLOW_ID = "SmJUalLZ058ShVIr";
const DEFAULT_N8N_BASE_URL = "http://18.222.117.210:5678";

const workflowId = process.env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID;
const baseUrl = String(process.env.N8N_BASE_URL || process.env.N8N_API_BASE_URL || DEFAULT_N8N_BASE_URL).replace(/\/+$/, "");

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const apiKey = process.env.N8N_API_KEY || await readStdin();
if (!apiKey) {
  throw new Error("N8N_API_KEY is required. Set the env var or pipe the key on stdin.");
}

async function n8n(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-N8N-API-KEY": apiKey,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`n8n ${options.method || "GET"} ${path} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function requiredNode(workflow, name) {
  const found = workflow.nodes.find((node) => node.name === name);
  if (!found) throw new Error(`Missing required node: ${name}`);
  return found;
}

const PLAYBOOK_TOOL_DESCRIPTION = [
  "Searches the official Pro Golf FAQ knowledge base and FAQ-derived support playbooks by meaning.",
  "Use this tool before replying to any non-greeting player message and before deciding that a message is outside Pro Golf.",
  "Results may include raw FAQ rows and generated support_playbook rows. A support_playbook row is operational guidance derived from FAQ content; use it to choose confirmations, troubleshooting checks, escalation triggers, handoff fields, and safe reply boundaries.",
  "Search queries must be topic-only. Search for general FAQ topics, product areas, reward sources, currencies, gameplay features, symptoms, and support policies.",
  "Do not include case-specific values in the search query: tournament IDs, tournament names, dollar amounts, dates, times, email addresses, PayPal emails, player IDs, transaction IDs, withdrawal references, device models, app versions, nicknames, or exact quoted form values.",
  "Convert specific facts into topic terms. Examples: \"$4 tournament\" becomes \"tournament reward prize pool winnings\"; \"I should get $1\" becomes \"missing tournament cash prize winnings\"; \"Apple Pay $9.99 yesterday\" becomes \"Apple Pay purchase payment missing deposit\".",
  "If the latest message is short or referential, use support_state and existing context to search the resolved topic.",
].join(" ");

const PLAYBOOK_PROMPT_SECTION = `## Retrieved FAQ Playbooks

The Search FAQ Knowledge Base tool searches a shared PGVector table that can contain two document types:
- Raw FAQ rows: normal official FAQ text.
- support_playbook rows: operational playbooks generated from the FAQ text and marked with metadata.doc_type = "support_playbook".

When a retrieved document is a support_playbook:
- Treat it as support-agent guidance, not as player-facing article text.
- Use issue_patterns, applies_when, and does_not_apply_when to decide whether it applies to the current issue.
- Use required_confirmations and troubleshooting_steps to choose the next useful clarification or check.
- Do not repeat a troubleshooting step if it is already reflected in support_state.asked_checks, support_state.answered_checks, known_values, or the player's latest answer.
- Use escalation_triggers to decide when the FAQ path is exhausted and human support is needed.
- Use handoff_fields to populate collected_fields when escalating or handing off.
- Treat forbidden_claims as hard limits.
- Do not mention playbooks, retrieval, metadata, embeddings, or internal document types to the player.

If both raw FAQ rows and support_playbook rows are retrieved, prefer the playbook for workflow decisions and the raw FAQ/playbook text for grounded wording. Never invent facts, mechanics, timing, compensation, or account-specific outcomes that are not supported by retrieved content.
`;

function patchSearchTool(workflow) {
  const node = requiredNode(workflow, "Search FAQ Knowledge Base");
  node.parameters.toolDescription = PLAYBOOK_TOOL_DESCRIPTION;
  node.parameters.topK = '={{ Number($env.PLAYBOOK_RAG_TOP_K || $env.RAG_TOP_K || 8) }}';
}

function patchSupportAgentPrompt(workflow) {
  const node = requiredNode(workflow, "Support Agent");
  const options = node.parameters.options || {};
  let systemMessage = String(options.systemMessage || "");

  if (!systemMessage.includes("## Retrieved FAQ Playbooks")) {
    if (systemMessage.includes("## Retrieval Rules")) {
      systemMessage = systemMessage.replace("## Retrieval Rules", `${PLAYBOOK_PROMPT_SECTION}\n## Retrieval Rules`);
    } else {
      systemMessage = `${systemMessage.trim()}\n\n${PLAYBOOK_PROMPT_SECTION}`;
    }
  }

  systemMessage = systemMessage.replace(
    "Use retrieved FAQs as both factual guidance and operational guidance:",
    "Use retrieved FAQs and retrieved support_playbook rows as both factual guidance and operational guidance:"
  );

  node.parameters.options = {
    ...options,
    systemMessage,
  };
}

function patchWorkflow(workflow) {
  patchSearchTool(workflow);
  patchSupportAgentPrompt(workflow);
}

function updateBody(workflow) {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: {
      executionOrder: workflow.settings?.executionOrder || "v1",
    },
  };
}

const response = await n8n(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
const workflow = response.data || response.workflow || response;
if (!workflow || !Array.isArray(workflow.nodes) || !workflow.connections) {
  throw new Error("Unexpected n8n workflow response shape.");
}

patchWorkflow(workflow);

await n8n(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
  method: "PUT",
  body: JSON.stringify(updateBody(workflow)),
});

console.log(`Patched workflow ${workflowId}: wired support_playbook retrieval into the PGVector staging support agent.`);
