/**
 * Mirrors logic in workflows/chatwoot-rag-guided-bot.json Flow Planner path Code nodes.
 * Update both if rules change.
 */

const HANDOFF_FLAGS = [
  "refund",
  "billing_dispute",
  "legal",
  "security",
  "data_deletion",
  "angry_customer",
  "human_requested",
  "credential_shared",
  "tool_failed",
  "unknown",
  "out_of_knowledge",
];

const STATE_KEY = "n8n_guided_flow";

/**
 * @param {unknown} raw
 */
export function parseFlowPlan(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { plan: raw, parseFailed: false };
  }

  const text = String(raw ?? "").trim();
  if (!text) {
    return {
      plan: null,
      parseFailed: true,
      error: "empty_flow_plan",
    };
  }

  try {
    const cleaned = text.replace(/^```json\s*|\s*```$/g, "");
    const plan = JSON.parse(cleaned);
    if (!plan || typeof plan !== "object") {
      return { plan: null, parseFailed: true, error: "invalid_flow_plan" };
    }
    return { plan, parseFailed: false };
  } catch {
    return { plan: null, parseFailed: true, error: "json_parse_failed" };
  }
}

/**
 * @param {Record<string, unknown>} guidedState
 * @param {{ isInteractiveSubmission?: boolean, interactiveContentType?: string|null, submittedValues?: unknown[], userText?: string }}
 */
export function applyGuidedInput(guidedState = {}, item = {}) {
  const state = {
    flow_version: 2,
    mode: "rag_guided",
    topic: guidedState.topic || null,
    path: Array.isArray(guidedState.path) ? [...guidedState.path] : [],
    slots: guidedState.slots && typeof guidedState.slots === "object" ? { ...guidedState.slots } : {},
    last_step_type: guidedState.last_step_type || null,
    llm_turns: Number(guidedState.llm_turns || 0),
    updated_at: guidedState.updated_at || null,
  };

  if (!item.isInteractiveSubmission) return state;

  const entries = Array.isArray(item.submittedValues) ? item.submittedValues : [];
  const first = entries[0];
  let selection = "";
  if (first && typeof first === "object") {
    selection = String(first.value || first.payload || first.name || first.title || "").trim();
  } else if (first) {
    selection = String(first).trim();
  }

  if (item.interactiveContentType === "form" && entries.length) {
    const formData = {};
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const key = entry.name || entry.id || entry.key || `field_${index + 1}`;
      formData[key] = entry.value ?? entry.answer ?? entry.text ?? "";
    });
    state.slots = { ...state.slots, ...formData };
    state.path.push(`form:${JSON.stringify(formData)}`);
    return state;
  }

  if (selection) {
    state.path.push(selection);
    if (!state.topic && state.path.length === 1) {
      state.topic = selection;
    } else {
      state.slots.last_selection = selection;
    }
  }

  return state;
}

/**
 * @param {{ plan?: Record<string, unknown>|null, retrieval?: { inScope?: boolean }, guardrailRiskFlags?: string[], contextFailed?: boolean, parseFailed?: boolean, minConfidence?: number }}
 */
export function evaluatePlanScope({
  plan,
  retrieval = {},
  guardrailRiskFlags = [],
  contextFailed = false,
  parseFailed = false,
  minConfidence = 0.7,
}) {
  const risk = new Set(guardrailRiskFlags || []);
  if (contextFailed) risk.add("tool_failed");
  if (parseFailed) risk.add("tool_failed");
  if (!retrieval.inScope) risk.add("out_of_knowledge");

  const confidence =
    plan && typeof plan.confidence === "number" ? plan.confidence : 0;
  const inScope = plan?.in_scope !== false;
  const needsHuman = plan?.needs_human === true;
  const stepType = String(plan?.step_type || "text").toLowerCase();

  const risky = [...risk].some((f) => HANDOFF_FLAGS.includes(f));
  const shouldHandoff =
    parseFailed ||
    !retrieval.inScope ||
    !inScope ||
    needsHuman ||
    stepType === "handoff" ||
    confidence < minConfidence ||
    risky;

  const action = shouldHandoff ? "handoff" : "guided_reply";
  const guidedAction = shouldHandoff ? "handoff" : "guided_reply";

  const knowledgeUsed = Array.isArray(plan?.knowledge_used)
    ? plan.knowledge_used.map(String)
    : [];

  const summary =
    typeof plan?.private_summary === "string" && plan.private_summary.trim()
      ? plan.private_summary.trim()
      : "RAG guided flow step.";

  return {
    action,
    guidedAction,
    confidence,
    riskFlags: Array.from(risk),
    knowledgeUsed,
    topic: typeof plan?.topic === "string" ? plan.topic : "unknown",
    stepType,
    publicAnswer: "",
    labelSuggestions: Array.isArray(plan?.labels)
      ? plan.labels.map(String)
      : ["rag_guided_bot"],
    privateSummary: [
      summary,
      `action=${action}`,
      `topic=${plan?.topic || "unknown"}`,
      `step_type=${stepType}`,
      `confidence=${confidence}`,
      `retrieval_in_scope=${Boolean(retrieval.inScope)}`,
      `retrieval_max_score=${retrieval.maxScore ?? 0}`,
      `knowledge_used=${knowledgeUsed.join(",")}`,
      `risk_flags=${Array.from(risk).join(",")}`,
    ].join(" | "),
  };
}

/**
 * @param {{ plan: Record<string, unknown> }}
 */
export function renderGuidedMessage({ plan }) {
  const tips = Array.isArray(plan.tips)
    ? plan.tips.filter((t) => String(t).trim())
    : [];
  const tipsBlock =
    tips.length > 0
      ? `\n\nQuick tips:\n${tips.map((t) => `• ${t}`).join("\n")}`
      : "";

  const stepType = String(plan.step_type || "text").toLowerCase();

  if (stepType === "options") {
    const options = Array.isArray(plan.options) ? plan.options : [];
    const content = `${plan.prompt || "Choose an option:"}${tipsBlock}`;
    return {
      content,
      message_type: "outgoing",
      private: false,
      content_type: "input_select",
      content_attributes: {
        items: options.map((option) => ({
          title: option.text || option.label || option.id,
          value: option.id || option.value || option.text,
        })),
      },
    };
  }

  const content = `${plan.prompt || plan.content || "Here's what we found."}${tipsBlock}`;
  return {
    content,
    message_type: "outgoing",
    private: false,
  };
}

/**
 * @param {{ plan: Record<string, unknown>, guidedState: Record<string, unknown> }}
 */
export function buildNextGuidedState({ plan, guidedState }) {
  const now = new Date().toISOString();
  const topic =
    typeof plan.topic === "string" && plan.topic
      ? plan.topic
      : guidedState.topic || null;

  return {
    flow_version: 2,
    mode: "rag_guided",
    topic,
    path: Array.isArray(guidedState.path) ? guidedState.path : [],
    slots: guidedState.slots || {},
    last_step_type: plan.step_type || null,
    llm_turns: Number(guidedState.llm_turns || 0) + 1,
    updated_at: now,
  };
}

export { STATE_KEY, HANDOFF_FLAGS };
