const DEFAULT_WORKFLOW_ID = "9HKjMKHoVwwqc8IU";
const DEFAULT_N8N_BASE_URL = "http://18.222.117.210:5678";
const ASSIGN_NODE_NAME = "Assign Escalation Agent";

const workflowId = process.env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID;
const baseUrl = String(process.env.N8N_BASE_URL || process.env.N8N_API_BASE_URL || DEFAULT_N8N_BASE_URL).replace(/\/+$/, "");
const apiKey = process.env.N8N_API_KEY;

if (!apiKey) {
  throw new Error("N8N_API_KEY is required to patch the workflow.");
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

function updateBody(workflow) {
  const allowed = [
    "name",
    "nodes",
    "connections",
    "settings",
    "staticData",
    "tags",
  ];
  return Object.fromEntries(allowed.filter((key) => key in workflow).map((key) => [key, workflow[key]]));
}

function findNode(workflow, name) {
  return workflow.nodes.find((node) => node.name === name);
}

function outgoingTargets(workflow, nodeName) {
  return workflow.connections?.[nodeName]?.main?.[0] || [];
}

function setOutgoingTargets(workflow, nodeName, targets) {
  if (!workflow.connections[nodeName]) workflow.connections[nodeName] = {};
  workflow.connections[nodeName].main = [targets];
}

function removeIncomingTarget(workflow, targetName) {
  for (const connection of Object.values(workflow.connections || {})) {
    const outputs = connection.main || [];
    for (const output of outputs) {
      if (!Array.isArray(output)) continue;
      for (let index = output.length - 1; index >= 0; index -= 1) {
        if (output[index]?.node === targetName) output.splice(index, 1);
      }
    }
  }
}

function patchWorkflow(workflow) {
  if (!Array.isArray(workflow.nodes) || !workflow.connections) {
    throw new Error("Unexpected workflow shape: expected nodes[] and connections.");
  }

  const openNode = findNode(workflow, "Open Conversation") || findNode(workflow, "Chatwoot Open + Assign");
  if (!openNode) {
    throw new Error("Could not find Open Conversation or Chatwoot Open + Assign node.");
  }

  const alreadyAssigned = findNode(workflow, ASSIGN_NODE_NAME);
  const downstream = outgoingTargets(workflow, openNode.name)
    .filter((target) => target.node !== ASSIGN_NODE_NAME);

  if (!downstream.length && !alreadyAssigned) {
    throw new Error(`Open node "${openNode.name}" has no downstream target to preserve.`);
  }

  const assignmentUrl = assignmentUrlFromOpenNode(openNode);

  const assignNode = {
    id: alreadyAssigned?.id || "chatwoot-explicit-assignee",
    name: ASSIGN_NODE_NAME,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: openNode.typeVersion || 4.2,
    position: [
      (openNode.position?.[0] || 0) + 220,
      openNode.position?.[1] || 0,
    ],
    parameters: {
      method: "POST",
      url: assignmentUrl,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: "api_access_token",
            value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}",
          },
          {
            name: "Content-Type",
            value: "application/json",
          },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ (() => {\n  const raw = String($env.CHATWOOT_ESCALATION_ASSIGNEE_ID || '').trim();\n  if (!/^\\d+$/.test(raw)) {\n    throw new Error('CHATWOOT_ESCALATION_ASSIGNEE_ID must be set to a numeric Chatwoot user id');\n  }\n  return JSON.stringify({ assignee_id: Number(raw) });\n})() }}",
      options: {
        timeout: openNode.parameters?.options?.timeout || 12000,
      },
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1500,
    notes: "Explicitly assigns bot handoff conversations to CHATWOOT_ESCALATION_ASSIGNEE_ID, including offline agents.",
    notesInFlow: true,
  };

  const existingIndex = workflow.nodes.findIndex((node) => node.name === ASSIGN_NODE_NAME);
  if (existingIndex === -1) workflow.nodes.push(assignNode);
  else workflow.nodes[existingIndex] = { ...workflow.nodes[existingIndex], ...assignNode };

  removeIncomingTarget(workflow, ASSIGN_NODE_NAME);
  setOutgoingTargets(workflow, openNode.name, [{ node: ASSIGN_NODE_NAME, type: "main", index: 0 }]);
  setOutgoingTargets(workflow, ASSIGN_NODE_NAME, downstream.length ? downstream : outgoingTargets(workflow, ASSIGN_NODE_NAME));

  return {
    openNode: openNode.name,
    preservedDownstream: outgoingTargets(workflow, ASSIGN_NODE_NAME).map((target) => target.node),
  };
}

function assignmentUrlFromOpenNode(openNode) {
  const url = String(openNode.parameters?.url || "");
  if (!url) throw new Error(`Open node "${openNode.name}" has no URL.`);

  if (url.includes("/toggle_status")) {
    return url.replace(/\/toggle_status/g, "/assignments");
  }

  if (url.trim().startsWith("={{") && url.trim().endsWith("}}")) {
    return url.replace(/\s*}}\s*$/, " + '/assignments' }}");
  }

  return `${url.replace(/\/+$/, "")}/assignments`;
}

const response = await n8n(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
const workflow = response.data || response.workflow || response;
const result = patchWorkflow(workflow);

await n8n(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
  method: "PUT",
  body: JSON.stringify(updateBody(workflow)),
});

console.log(`Patched workflow ${workflowId}: ${result.openNode} -> ${ASSIGN_NODE_NAME} -> ${result.preservedDownstream.join(", ")}`);
