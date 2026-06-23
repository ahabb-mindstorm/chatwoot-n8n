const DEFAULT_WORKFLOW_ID = "SmJUalLZ058ShVIr";
const DEFAULT_N8N_BASE_URL = "http://18.222.117.210:5678";

const workflowId = process.env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID;
const baseUrl = String(process.env.N8N_BASE_URL || process.env.N8N_API_BASE_URL || DEFAULT_N8N_BASE_URL).replace(/\/+$/, "");
const apiKey = process.env.N8N_API_KEY;

if (!apiKey) {
  throw new Error("N8N_API_KEY is required to patch the staging workflow.");
}

async function n8n(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "accept": "application/json",
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

function upsertNode(workflow, node) {
  const index = workflow.nodes.findIndex((existing) => existing.name === node.name);
  if (index === -1) {
    workflow.nodes.push(node);
  } else {
    workflow.nodes[index] = { ...workflow.nodes[index], ...node, id: workflow.nodes[index].id || node.id };
  }
}

function removeMemory(workflow) {
  workflow.nodes = workflow.nodes.filter((node) => node.name !== "Conversation Memory");
  delete workflow.connections["Conversation Memory"];
  for (const connection of Object.values(workflow.connections)) {
    for (const [type, outputs] of Object.entries(connection)) {
      connection[type] = outputs.map((output) => {
        const targets = Array.isArray(output) ? output : [];
        return targets.filter((target) => target.node !== "Conversation Memory" && target.type !== "ai_memory");
      });
    }
  }
}

function patchExtractEvent(workflow) {
  const node = requiredNode(workflow, "Extract Event");
  let code = String(node.parameters.jsCode || "");
  if (!code.includes("const supportState =")) {
    code = code.replace(
      "const knownValues = normalizeKnownValues(\n  contentAttrs.known_values,\n  contentAttrs.knownValues,\n  customAttrs.escalation_known_fields,\n  customAttrs.escalationKnownFields\n);\n",
      "const knownValues = normalizeKnownValues(\n  contentAttrs.known_values,\n  contentAttrs.knownValues,\n  customAttrs.escalation_known_fields,\n  customAttrs.escalationKnownFields\n);\nconst supportState = objectValue(customAttrs.support_state || customAttrs.supportState || {});\n"
    );
  }
  if (!code.includes("supportState,")) {
    code = code.replace("  knownValues,\n  customAttributes:", "  knownValues,\n  supportState,\n  customAttributes:");
  }
  node.parameters.jsCode = code;
}

function supportAgentTextExpression() {
  return "={{ 'Player message: ' + ($json.content || '') + '\\n\\nCurated support_state for this conversation:\\n' + JSON.stringify($json.supportState || {}) + '\\n\\nExisting escalation/custom attribute context:\\n' + (($json.category && $json.category !== 'other') ? ('- category: ' + $json.category + '\\n') : '') + ($json.rewardSource ? ('- reward_source: ' + $json.rewardSource + '\\n') : '') + ($json.summary ? ('- prior_summary: ' + $json.summary + '\\n') : '') + (Object.keys($json.knownValues || {}).length ? ('- known_values: ' + JSON.stringify($json.knownValues) + '\\n') : '') + ((($json.customAttributes || {}).escalation_missing_fields) ? ('- missing_fields_for_form: ' + (($json.customAttributes || {}).escalation_missing_fields) + '\\n') : '') + ((($json.customAttributes || {}).escalation_omitted_fields) ? ('- already_collected_fields: ' + (($json.customAttributes || {}).escalation_omitted_fields) + '\\n') : '') }}";
}

function patchSupportAgent(workflow) {
  const node = requiredNode(workflow, "Support Agent");
  node.parameters.text = supportAgentTextExpression();
  const options = node.parameters.options || {};
  let systemMessage = String(options.systemMessage || "");
  if (!systemMessage.includes("## Curated support_state")) {
    systemMessage = systemMessage.replace(
      "## How to answer\n",
      "## Curated support_state\n\nThe input includes support_state, a compact support-case state stored on the Chatwoot conversation. There is no automatic transcript memory. Use support_state.category, support_state.reward_source, support_state.current_issue, support_state.known_fields, support_state.confirmed_facts, and support_state.last_bot_question to resolve short follow-ups like \"it\", \"them\", \"daily reward\", \"still didn't get it\", or \"$1\".\n\nStore and rely only on confirmed player-provided facts. Do not treat support_state as FAQ evidence, and do not let an old support_state force an in-scope answer when the latest message is clearly unrelated to Pro Golf.\n\n## How to answer\n"
    );
  }
  if (!systemMessage.includes("pending_clarification")) {
    systemMessage = systemMessage.replace(
      "## Follow-up interpretation\n",
      "## Follow-up interpretation\n\nThe support_state may include pending_clarification with an id, question, and expected_answer_type. If the latest player message is a short answer such as \"yes\", \"no\", \"yes i have\", \"still missing\", \"I checked\", or an amount like \"$1\", interpret it against pending_clarification before doing any unrelated-topic boundary check. A short answer to your own pending support question is in-scope. Do not respond with the generic Pro Golf boundary message when the player is answering pending_clarification.\n\n"
    );
  }
  systemMessage = systemMessage
    .replace(/conversation memory and confirmed facts/g, "support_state and confirmed facts")
    .replace(/conversation memory/g, "support_state")
    .replace(/Use support_state to choose the right topic, not to stuff exact values into the query\./g, "Use support_state to choose the right topic, not to stuff exact values into the query.");
  node.parameters.options = { ...options, systemMessage };
}

function buildSupportStateCode() {
  return `const ev = $('Extract Event').first().json;
const item = $input.first().json;
const out = item.output || {};
const previous = ev.supportState && typeof ev.supportState === 'object' && !Array.isArray(ev.supportState)
  ? ev.supportState
  : {};

function clean(value) {
  return String(value ?? '').replace(/\\s+/g, ' ').trim();
}

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonEmptyEntries(value) {
  return Object.entries(objectValue(value)).filter(([, raw]) => clean(raw));
}

function mergeKnownFields(...sources) {
  const known = {};
  for (const source of sources) {
    for (const [key, value] of nonEmptyEntries(source)) {
      known[key] = clean(value);
    }
  }
  return known;
}

function supportedFaqIds(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(new Set(list.map((id) => clean(id)).filter(Boolean))).slice(0, 8);
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))).slice(0, 25);
}

function lastQuestion(reply) {
  const text = String(reply || '').trim();
  const matches = text.match(/[^.!?]*\\?+/g) || [];
  return clean(matches.at(-1) || '');
}

function pendingFromQuestion(question) {
  const text = clean(question);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/playing any tournaments|played any tournaments|playing tournaments|played tournaments/.test(lower)) {
    return { id: 'played_tournaments', question: text.slice(0, 500), expected_answer_type: 'boolean' };
  }
  if (/how much|amount|expected reward|reward amount|what amount/.test(lower)) {
    return { id: 'expected_reward', question: text.slice(0, 500), expected_answer_type: 'money' };
  }
  if (/prizes tab/.test(lower)) {
    return { id: 'checked_prizes_tab', question: text.slice(0, 500), expected_answer_type: 'boolean' };
  }
  if (/tournament.*conclud|result.*pending|final/.test(lower)) {
    return { id: 'confirmed_tournament_concluded', question: text.slice(0, 500), expected_answer_type: 'boolean' };
  }
  return { id: 'follow_up', question: text.slice(0, 500), expected_answer_type: /\\b(did|have|are|is|was|can|could|would)\\b/i.test(text) ? 'boolean' : 'free_text' };
}

function amountFrom(text) {
  const match = clean(text).match(/(?:\\$|usd\\s*)?\\s*(\\d+(?:\\.\\d{1,2})?)\\s*(?:dollars?|usd|cash|coins?|tickets?)?/i);
  return match ? clean(match[0]) : '';
}

function isYes(text) {
  return /^(yes|yeah|yep|yup|i have|yes i have|i did|done|checked|i checked|already did)$/i.test(clean(text));
}

function isNo(text) {
  return /^(no|nope|nah|not yet|i have not|haven't|didn't)$/i.test(clean(text));
}

function answeredPending(pending, text) {
  if (!pending || typeof pending !== 'object') return { answered: false, facts: {}, fields: {}, checks: [] };
  const id = clean(pending.id || pending.field || 'follow_up') || 'follow_up';
  const type = clean(pending.expected_answer_type || pending.type).toLowerCase();
  const yes = isYes(text);
  const no = isNo(text);
  const amount = amountFrom(text);
  const facts = {};
  const fields = {};
  const checks = [];

  if ((type === 'boolean' || /played|checked|confirm|concluded/.test(id)) && (yes || no)) {
    facts[id] = yes;
    if (/prizes|checked|confirm|concluded/.test(id)) checks.push(id);
    return { answered: true, facts, fields, checks };
  }

  if ((type === 'money' || /amount|reward|prize|payout/.test(id)) && amount) {
    fields[id] = amount;
    return { answered: true, facts, fields, checks };
  }

  if (/still missing|still not|not there|not showing|missing/i.test(clean(text))) {
    facts[id + '_still_missing'] = true;
    checks.push(id);
    return { answered: true, facts, fields, checks };
  }

  if (clean(text).length > 2 && clean(text).length < 200 && !/^(hi|hello|hey|thanks)$/i.test(clean(text))) {
    fields[id] = clean(text).slice(0, 200);
    return { answered: true, facts, fields, checks };
  }

  return { answered: false, facts: {}, fields: {}, checks: [] };
}

function checksFromReply(reply) {
  const lower = clean(reply).toLowerCase();
  const checks = [];
  if (/prizes tab/.test(lower)) checks.push('check_prizes_tab');
  if (/tournament.*conclud|concluded|final results/.test(lower)) checks.push('confirm_tournament_concluded');
  if (/cash or bonus cash|bonus cash/.test(lower)) checks.push('check_cash_bonus_cash_split');
  if (/support team|human agent|ticket id/.test(lower)) checks.push('contact_support');
  return checks;
}

function currentIssue() {
  const candidates = [
    previous.current_issue,
    out.summary,
    ev.summary,
    ev.content,
  ].map(clean).filter(Boolean);
  return (candidates[0] || '').slice(0, 240);
}

const userMessage = clean(ev.content);
const amountMatch = userMessage.match(/\\$\\s*\\d+(?:\\.\\d{1,2})?|\\b\\d+(?:\\.\\d{1,2})?\\s*(?:dollars?|cash|coins?|tickets?)\\b/i);
const previousKnownFields = objectValue(previous.known_fields);
const collectedFields = objectValue(out.collected_fields || out.collectedFields);
const knownFields = mergeKnownFields(previousKnownFields, ev.knownValues, collectedFields);
const previousPending = previous.pending_clarification && typeof previous.pending_clarification === 'object'
  ? previous.pending_clarification
  : pendingFromQuestion(previous.last_bot_question);
const pendingAnswer = answeredPending(previousPending, userMessage);
Object.assign(knownFields, pendingAnswer.fields);

if (amountMatch && !knownFields.expected_reward && /amount|expected|reward|prize|payout|missing|what.*show/i.test(clean(previous.last_bot_question))) {
  knownFields.expected_reward = clean(amountMatch[0]);
}

const confirmedFacts = {
  ...objectValue(previous.confirmed_facts),
  ...pendingAnswer.facts,
};
const category = clean(out.category || previous.category || ev.category || 'other') || 'other';
const rewardSource = clean(out.reward_source || out.rewardSource || previous.reward_source || ev.rewardSource);
if (category && category !== 'other') confirmedFacts.category = category;
if (rewardSource) confirmedFacts.reward_source = rewardSource;
const question = lastQuestion(out.reply);
const pending = out.action === 'handoff'
  ? null
  : (question ? pendingFromQuestion(question) : (pendingAnswer.answered ? null : previousPending || null));
const askedChecks = uniqueStrings([...(previous.asked_checks || []), ...checksFromReply(out.reply)]);
const answeredChecks = uniqueStrings([...(previous.answered_checks || []), ...pendingAnswer.checks]);

const supportState = {
  version: 1,
  updated_at: new Date().toISOString(),
  turn_count: Number(previous.turn_count || 0) + 1,
  category,
  reward_source: rewardSource,
  current_issue: currentIssue(),
  confirmed_facts: confirmedFacts,
  known_fields: knownFields,
  pending_clarification: pending,
  asked_checks: askedChecks,
  answered_checks: answeredChecks,
  last_user_message: userMessage.slice(0, 240),
  last_bot_reply_summary: clean(out.summary || out.reply).slice(0, 240),
  last_bot_question: question || clean(previous.last_bot_question),
  last_action: clean(out.action || previous.last_action),
  last_supported_faq_ids: supportedFaqIds(out.qa_faq_ids || out.faq_ids || previous.last_supported_faq_ids),
  qa_status: clean(out.qa_status || previous.qa_status),
};

return [{ json: { ...item, support_state: supportState, supportState } }];`;
}

function restoreSupportStateCode() {
  return "const built = $('Build Support State').first().json;\nreturn [{ json: built }];";
}

function patchSupportStateNodes(workflow) {
  const source = workflow.nodes.find((node) => node.name === "Grounding QA Agent")
    || workflow.nodes.find((node) => node.name === "Support Agent");
  const merge = requiredNode(workflow, "Merge QA With Routing Decision");
  if (!source) throw new Error("Missing required node: Grounding QA Agent or Support Agent");
  const sourceX = Number(Array.isArray(source.position) ? source.position[0] : 1392);
  const sourceY = Number(Array.isArray(source.position) ? source.position[1] : 112);
  const mergeX = Number(Array.isArray(merge.position) ? merge.position[0] : sourceX + 672);
  const mergeY = Number(Array.isArray(merge.position) ? merge.position[1] : sourceY);

  upsertNode(workflow, {
    id: "e938c6f1-54f0-47a1-a768-6cb5f67906dc",
    name: "Build Support State",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [sourceX + 224, sourceY],
    parameters: { jsCode: buildSupportStateCode() },
  });

  upsertNode(workflow, {
    id: "d27dab06-3f84-4a98-a0d1-b197f31fbf87",
    name: "Save Support State",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [sourceX + 448, sourceY],
    parameters: {
      method: "POST",
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/custom_attributes",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }] },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ custom_attributes: Object.assign({}, $('Extract Event').first().json.customAttributes || {}, { support_state: $('Build Support State').first().json.support_state }) }) }}",
      options: {},
    },
  });

  upsertNode(workflow, {
    id: "e4f995f4-93a0-48cd-8610-a876704327ef",
    name: "Restore Support State Context",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [Math.min(mergeX - 224, sourceX + 672), mergeY],
    parameters: { jsCode: restoreSupportStateCode() },
  });

  workflow.connections[source.name] = { ...(workflow.connections[source.name] || {}), main: [[{ node: "Build Support State", type: "main", index: 0 }]] };
  workflow.connections["Build Support State"] = { main: [[{ node: "Save Support State", type: "main", index: 0 }]] };
  workflow.connections["Save Support State"] = { main: [[{ node: "Restore Support State Context", type: "main", index: 0 }]] };
  workflow.connections["Restore Support State Context"] = { main: [[{ node: "Merge QA With Routing Decision", type: "main", index: 0 }]] };
}

function patchBuildEscalationForm(workflow) {
  const node = requiredNode(workflow, "Build Escalation Form");
  let code = String(node.parameters.jsCode || "");
  if (!code.includes("const latestSupportState =")) {
    code = code.replace(
      "const customAttributes = {\n  ...existingCustomAttributes,\n  escalation_category: category,",
      "const latestSupportState = item.support_state || item.supportState || existingCustomAttributes.support_state;\nconst customAttributes = {\n  ...existingCustomAttributes,\n  ...(latestSupportState ? { support_state: latestSupportState } : {}),\n  escalation_category: category,"
    );
  }
  node.parameters.jsCode = code;
}

function patchWorkflow(workflow) {
  removeMemory(workflow);
  patchExtractEvent(workflow);
  patchSupportAgent(workflow);
  patchSupportStateNodes(workflow);
  patchBuildEscalationForm(workflow);
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

console.log(`Patched workflow ${workflowId}: removed Conversation Memory, added support_state persistence, and preserved PGVector staging webhook.`);
