import { fileURLToPath } from "node:url";

const DEFAULT_WORKFLOW_ID = "GcKbOSy3k8hqfqIr";
const DEFAULT_N8N_BASE_URL = "http://18.222.117.210:5678";

const TYPING_URL = "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/toggle_typing_status";

export function requiredNode(workflow, name) {
  const found = workflow.nodes.find((node) => node.name === name);
  if (!found) throw new Error(`Missing required node: ${name}`);
  return found;
}

export function upsertNode(workflow, node) {
  const index = workflow.nodes.findIndex((existing) => existing.name === node.name);
  if (index === -1) {
    workflow.nodes.push(node);
  } else {
    workflow.nodes[index] = { ...workflow.nodes[index], ...node, id: workflow.nodes[index].id || node.id };
  }
}

function buildTypingHttpNode(name, position, typingStatus) {
  return {
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position,
    alwaysOutputData: true,
    onError: "continueRegularOutput",
    parameters: {
      method: "POST",
      url: TYPING_URL,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" },
          { name: "Content-Type", value: "application/json" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: `={{ JSON.stringify({ typing_status: '${typingStatus}', is_private: false }) }}`,
      options: { timeout: 5000 },
    },
  };
}

function buildTypingEnabledIfNode(position) {
  return {
    name: "Typing Indicators Enabled?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
          version: 2,
        },
        conditions: [
          {
            id: "typing-indicators-enabled",
            leftValue: "={{ String($env.CHATWOOT_TYPING_INDICATORS ?? 'true').trim().toLowerCase() }}",
            rightValue: "false",
            operator: {
              type: "string",
              operation: "notEquals",
            },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
  };
}

function buildWaitBeforeTypingNode(position) {
  return {
    name: "Wait Before Typing",
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position,
    parameters: {
      amount: 0.4,
      unit: "seconds",
    },
  };
}

export function patchWorkflow(workflow) {
  const routeEvent = requiredNode(workflow, "Route Event");
  const sendReply = requiredNode(workflow, "Send Reply");
  const sendEscalationForm = requiredNode(workflow, "Send Escalation Form");
  const notifyPlayer = requiredNode(workflow, "Notify Player");
  const prepareHandoff = requiredNode(workflow, "Prepare Handoff");
  const routeRequirementLookup = requiredNode(workflow, "Route Requirement Lookup");
  const routeSavedEscalation = requiredNode(workflow, "Route Saved Escalation");

  const routeX = Number(routeEvent.position?.[0] ?? 448);
  const routeY = Number(routeEvent.position?.[1] ?? 304);
  const replyX = Number(sendReply.position?.[0] ?? 2160);
  const replyY = Number(sendReply.position?.[1] ?? 144);
  const formX = Number(sendEscalationForm.position?.[0] ?? 3728);
  const formY = Number(sendEscalationForm.position?.[1] ?? 480);
  const handoffX = Number(prepareHandoff.position?.[0] ?? 3728);
  const handoffY = Number(prepareHandoff.position?.[1] ?? 224);
  const notifyX = Number(notifyPlayer.position?.[0] ?? 4400);
  const notifyY = Number(notifyPlayer.position?.[1] ?? 224);
  const reqLookupX = Number(routeRequirementLookup.position?.[0] ?? 1936);
  const reqLookupY = Number(routeRequirementLookup.position?.[1] ?? 192);
  const savedEscX = Number(routeSavedEscalation.position?.[0] ?? 3504);
  const savedEscY = Number(routeSavedEscalation.position?.[1] ?? 320);

  upsertNode(workflow, {
    id: "typing-indicators-enabled-if",
    ...buildTypingEnabledIfNode([routeX + 160, routeY - 176]),
  });

  upsertNode(workflow, {
    id: "wait-before-typing",
    ...buildWaitBeforeTypingNode([routeX + 384, routeY - 176]),
  });

  upsertNode(workflow, {
    id: "typing-on-node",
    ...buildTypingHttpNode("Typing On", [routeX + 608, routeY - 176], "on"),
  });

  upsertNode(workflow, {
    id: "typing-off-before-reply",
    ...buildTypingHttpNode("Typing Off Before Reply", [reqLookupX + 112, reqLookupY - 48], "off"),
  });

  upsertNode(workflow, {
    id: "typing-off-before-form",
    ...buildTypingHttpNode("Typing Off Before Form", [savedEscX + 112, savedEscY + 80], "off"),
  });

  upsertNode(workflow, {
    id: "typing-off-before-notify",
    ...buildTypingHttpNode("Typing Off Before Notify", [handoffX + 112, handoffY], "off"),
  });

  // Route Event (User Message) -> Typing Indicators Enabled?
  workflow.connections["Route Event"] = workflow.connections["Route Event"] || {};
  const routeMain = workflow.connections["Route Event"].main || [[], []];
  routeMain[0] = [{ node: "Typing Indicators Enabled?", type: "main", index: 0 }];
  routeMain[1] = routeMain[1] || [{ node: "Prepare Handoff", type: "main", index: 0 }];
  workflow.connections["Route Event"].main = routeMain;

  workflow.connections["Typing Indicators Enabled?"] = {
    main: [
      [{ node: "Wait Before Typing", type: "main", index: 0 }],
      [{ node: "Support Agent", type: "main", index: 0 }],
    ],
  };

  workflow.connections["Wait Before Typing"] = {
    main: [[{ node: "Typing On", type: "main", index: 0 }]],
  };

  workflow.connections["Typing On"] = {
    main: [[{ node: "Support Agent", type: "main", index: 0 }]],
  };

  // Route Requirement Lookup (reply) -> Typing Off Before Reply -> Send Reply
  workflow.connections["Route Requirement Lookup"] = workflow.connections["Route Requirement Lookup"] || {};
  const reqMain = workflow.connections["Route Requirement Lookup"].main || [[], []];
  reqMain[0] = [{ node: "Typing Off Before Reply", type: "main", index: 0 }];
  workflow.connections["Route Requirement Lookup"].main = reqMain;

  workflow.connections["Typing Off Before Reply"] = {
    main: [[{ node: "Send Reply", type: "main", index: 0 }]],
  };

  // Route Saved Escalation (form) -> Typing Off Before Form -> Send Escalation Form
  workflow.connections["Route Saved Escalation"] = workflow.connections["Route Saved Escalation"] || {};
  const savedMain = workflow.connections["Route Saved Escalation"].main || [[], []];
  savedMain[0] = [{ node: "Typing Off Before Form", type: "main", index: 0 }];
  workflow.connections["Route Saved Escalation"].main = savedMain;

  workflow.connections["Typing Off Before Form"] = {
    main: [[{ node: "Send Escalation Form", type: "main", index: 0 }]],
  };

  // Label Conversation -> Typing Off Before Notify -> Notify Player
  workflow.connections["Label Conversation"] = {
    main: [[{ node: "Typing Off Before Notify", type: "main", index: 0 }]],
  };

  workflow.connections["Typing Off Before Notify"] = {
    main: [[{ node: "Notify Player", type: "main", index: 0 }]],
  };

  // Restore handoff chain: Prepare Handoff -> Post Internal Note -> Label Conversation
  workflow.connections["Prepare Handoff"] = {
    main: [[{ node: "Post Internal Note", type: "main", index: 0 }]],
  };

  // Remove stale direct connections replaced by typing nodes.
  for (const [source, connection] of Object.entries(workflow.connections)) {
    if (!connection?.main) continue;
    connection.main = connection.main.map((output) => {
      if (!Array.isArray(output)) return output;
      return output.filter((target) => {
        if (source === "Route Event" && target.node === "Support Agent") return false;
        if (source === "Route Requirement Lookup" && target.node === "Send Reply") return false;
        if (source === "Route Saved Escalation" && target.node === "Send Escalation Form") return false;
        if (source === "Label Conversation" && target.node === "Notify Player") return false;
        return true;
      });
    });
  }

  // Nudge downstream nodes slightly right if they overlap new typing-off nodes.
  sendReply.position = [replyX + 48, replyY];
  sendEscalationForm.position = [formX + 48, formY];
  notifyPlayer.position = [notifyX + 48, notifyY];

  return workflow;
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

async function n8n(baseUrl, apiKey, path, options = {}) {
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

async function main() {
  const workflowId = process.env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID;
  const baseUrl = String(process.env.N8N_BASE_URL || process.env.N8N_API_BASE_URL || DEFAULT_N8N_BASE_URL).replace(/\/+$/, "");
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY is required to patch the workflow.");
  }

  const response = await n8n(baseUrl, apiKey, `/api/v1/workflows/${encodeURIComponent(workflowId)}`);
  const workflow = response.data || response.workflow || response;
  if (!workflow || !Array.isArray(workflow.nodes) || !workflow.connections) {
    throw new Error("Unexpected n8n workflow response shape.");
  }

  patchWorkflow(workflow);

  await n8n(baseUrl, apiKey, `/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PUT",
    body: JSON.stringify(updateBody(workflow)),
  });

  console.log(`Patched workflow ${workflowId}: added Chatwoot typing indicators (on during Support Agent, off before public messages).`);
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
