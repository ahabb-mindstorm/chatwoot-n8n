/**
 * Static guided-flow engine for Postgres-backed bot workflow.
 * Mirrors Continue Guided Flow / Start Guided Flow Code nodes.
 */

export const DEFAULT_GUIDED_FLOW = {
  version: 1,
  entry: "main",
  entries: {
    main_menu: "main",
    tournament: "main",
  },
  nodes: {
    main: {
      type: "options",
      prompt: "What can I help you with?",
      options: [
        { id: "lost_reward", text: "Lost Reward", target: "lost_reward_form" },
        { id: "withdrawal", text: "Withdrawal", target: "withdrawal_menu" },
        { id: "custom", text: "Ask a custom question", target: "llm" },
        { id: "human", text: "Talk to a human", target: "human" },
      ],
    },
    lost_reward_form: {
      type: "form",
      prompt: "Tell us about the lost reward.",
      fields: [
        {
          id: "lost_location",
          label: "Where did you lose it?",
          type: "text",
          required: true,
          placeholder: "Game, screen, or reward name",
        },
      ],
      submitTarget: "human",
    },
    withdrawal_menu: {
      type: "options",
      prompt: "Withdrawal help",
      options: [
        { id: "withdrawal_timing", text: "How long does withdrawal take?", target: "withdrawal_timing_answer" },
        { id: "withdrawal_how", text: "How to withdraw", target: "withdrawal_how_answer" },
        { id: "withdrawal_problem", text: "Problem with withdraw", target: "withdrawal_problem_menu" },
      ],
    },
    withdrawal_timing_answer: {
      type: "text",
      content: "Withdrawals take 2-3 days.",
      next: "resolution_check",
    },
    withdrawal_how_answer: {
      type: "text",
      content:
        "Go to Settings, open Withdrawals, choose your method, then submit the withdrawal request.",
      next: "resolution_check",
    },
    withdrawal_problem_menu: {
      type: "options",
      prompt: "What happened with the withdrawal?",
      options: [
        { id: "withdrawal_too_long", text: "Taking too long", target: "withdrawal_problem_form" },
        { id: "withdrawal_errored", text: "Errored out", target: "withdrawal_problem_form" },
      ],
    },
    withdrawal_problem_form: {
      type: "form",
      prompt: "Share withdrawal details so a human can investigate.",
      fields: [
        { id: "withdrawal_id", label: "Withdrawal ID or account email", type: "text", required: true },
        { id: "problem_details", label: "What happened?", type: "text_area", required: true },
      ],
      submitTarget: "human",
    },
    resolution_check: {
      type: "options",
      prompt: "Did this resolve your issue?",
      options: [
        { id: "resolved_yes", text: "Yes, resolved", target: "resolved" },
        { id: "resolved_no", text: "No, talk to a human", target: "human" },
        { id: "another_question", text: "Ask another question", target: "llm" },
        { id: "show_menu", text: "Show menu again", target: "main" },
      ],
    },
    resolved: {
      type: "text",
      content:
        "Glad I could help. If anything else comes up, send a new message and I will show the support menu again.",
    },
    llm: {
      type: "llm",
      prompt:
        "Please describe the issue in your own words. I will try to help, and I will hand this to a human if we cannot resolve it.",
    },
    human: { type: "human" },
  },
};

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function submittedEntries(item) {
  if (Array.isArray(item.submittedValues)) return item.submittedValues;
  const payload = item.rawPayload || {};
  const attrs = payload.message?.content_attributes || payload.content_attributes || {};
  const submitted = attrs.submitted_values || attrs.submittedValues || [];
  if (Array.isArray(submitted)) return submitted;
  if (submitted && typeof submitted === "object") {
    return Object.entries(submitted).map(([name, value]) => ({ name, value }));
  }
  return submitted ? [{ value: submitted }] : [];
}

function firstSubmittedValue(entries) {
  const first = entries[0];
  if (!first) return "";
  if (typeof first === "object") {
    return first.value || first.payload || first.name || first.title || "";
  }
  return first;
}

function collectFormData(entries) {
  const data = {};
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const key = entry.name || entry.id || entry.key || `field_${index + 1}`;
    data[key] = entry.value ?? entry.answer ?? entry.text ?? "";
  });
  return data;
}

function collectAttachments(item) {
  if (Array.isArray(item.attachments)) return item.attachments;
  const payload = item.rawPayload || {};
  const message = payload.message && typeof payload.message === "object" ? payload.message : payload;
  const sources = [message.attachments, payload.attachments, payload.message?.attachments];
  return sources.find((value) => Array.isArray(value)) || [];
}

function normalizeAttachments(attachments) {
  return attachments.map((attachment, index) => ({
    id: attachment.id ?? attachment.file_id ?? attachment.blob_id ?? null,
    file_type: attachment.file_type || attachment.fileType || attachment.type || null,
    file_name: attachment.file_name || attachment.filename || attachment.name || `attachment_${index + 1}`,
    data_url: attachment.data_url || attachment.url || attachment.download_url || attachment.thumb_url || null,
    fallback_url: attachment.fallback_url || attachment.external_url || null,
    raw: attachment,
  }));
}

function menuBody(content, options) {
  return {
    content,
    message_type: "outgoing",
    private: false,
    content_type: "input_select",
    content_attributes: {
      items: (options || []).map((option) => ({
        title: option.text,
        value: option.id,
      })),
    },
  };
}

function formBody(node) {
  const typeMap = {
    textarea: "text_area",
    text_area: "text_area",
    email: "email",
    select: "select",
    text: "text",
  };
  return {
    content: node.prompt || "Please provide the details below.",
    message_type: "outgoing",
    private: false,
    content_type: "form",
    content_attributes: {
      items: (node.fields || []).map((field) => ({
        name: field.id,
        label: field.label || field.prompt || field.id,
        type: typeMap[field.type] || "text",
        placeholder: field.placeholder || "",
        required: field.required === true,
        options: Array.isArray(field.options)
          ? field.options.map((option) => ({
              label: option.label || option.text,
              value: option.value || option.id || option.text,
            }))
          : undefined,
      })),
    },
  };
}

function textBody(content) {
  return { content, message_type: "outgoing", private: false };
}

function validateFlow(flow) {
  return (
    flow &&
    typeof flow === "object" &&
    flow.entry &&
    flow.nodes &&
    typeof flow.nodes === "object" &&
    flow.nodes[flow.entry]
  );
}

function findOption(node, rawValue, textValue) {
  const options = Array.isArray(node?.options) ? node.options : [];
  const direct = String(rawValue || "").trim();
  const directSlug = slug(direct || textValue);
  return options.find(
    (option) =>
      option.id === direct || slug(option.id) === directSlug || slug(option.text) === directSlug,
  );
}

function conversationCustomAttributes(item = {}) {
  const payload = item.rawPayload || {};
  return (
    item.customAttributes ||
    payload.custom_attributes ||
    payload.conversation?.custom_attributes ||
    payload.conversation?.payload?.custom_attributes ||
    {}
  );
}

export function startNodeForItem(flow, item = {}) {
  const attrs = conversationCustomAttributes(item);
  const source = String(attrs.support_landing_source || item.supportLandingSource || "").trim();
  const entries = flow?.entries && typeof flow.entries === "object" ? flow.entries : {};
  const candidate = entries[source] || flow?.entry;
  return flow?.nodes?.[candidate] ? candidate : flow?.entry;
}

export function emptyFlowState(flow, item = {}) {
  const startNode = startNodeForItem(flow, item);
  return {
    flow_version: flow.version || 1,
    current_node: startNode,
    path: [],
    form_data: {},
    llm_turns: 0,
    selected_option: null,
    mode: null,
    step: null,
    resolved: false,
  };
}

export function isActiveFlow(dbState) {
  if (!dbState) return false;
  return (
    dbState.flow_status === "active" &&
    Boolean(dbState.active_flow_id) &&
    dbState.bot_status !== "handoff"
  );
}

export function runGuidedFlow({
  flow = DEFAULT_GUIDED_FLOW,
  item,
  dbState = null,
  startNew = false,
  flowId = "support_main",
}) {
  const now = new Date().toISOString();
  const startNodeId = startNodeForItem(flow, item);
  const stored = dbState?.flow_state && typeof dbState.flow_state === "object" ? dbState.flow_state : {};
  const baseState = startNew
    ? emptyFlowState(flow, item)
    : {
        flow_version: stored.flow_version || flow.version || 1,
        current_node: stored.current_node || dbState?.current_node || startNodeId,
        path: Array.isArray(stored.path) ? stored.path : [],
        form_data: stored.form_data && typeof stored.form_data === "object" ? stored.form_data : {},
        llm_turns: Number(stored.llm_turns || 0),
        selected_option: stored.selected_option || null,
        mode: stored.mode || dbState?.current_step || null,
        step: stored.step || null,
        resolved: stored.resolved === true,
      };

  function handoff(reason, nodeId, extra = {}) {
    const state = {
      ...baseState,
      current_node: nodeId || baseState.current_node || startNodeId,
      mode: "handoff",
      step: reason,
      last_action: reason,
      resolved: false,
      updated_at: now,
      ...extra.state,
    };
    return {
      guidedAction: "handoff",
      action: "handoff",
      route: "human_handoff",
      nextFlowState: state,
      guidedMessageBody: null,
      activeFlowId: flowId,
      flowVersion: flow.version || 1,
      currentNode: state.current_node,
      currentStep: state.step,
      botStatus: "handoff",
      flowStatus: "handoff",
      caseType: extra.caseType || "guided_flow",
      intent: reason,
      labelSuggestions: Array.from(
        new Set([...(item.guardrailLabels || []), "guided_flow", ...(extra.labels || [])]),
      ),
      privateSummary:
        extra.summary ||
        `Guided flow handoff. reason=${reason} node=${nodeId || baseState.current_node}`,
      pendingSubmission: extra.pendingSubmission || null,
    };
  }

  function renderNode(nodeId, patch = {}) {
    const node = flow.nodes[nodeId];
    if (!node) {
      return handoff("guided_flow_missing_node", nodeId, {
        labels: ["guided_flow_error"],
        summary: `Guided flow missing node: ${nodeId}`,
      });
    }
    const common = {
      ...baseState,
      current_node: nodeId,
      mode: node.type,
      step: node.type,
      last_action: `show_${node.type}`,
      resolved: false,
      updated_at: now,
      ...patch,
    };
    if (node.type === "options") {
      return {
        guidedAction: "guided_reply",
        action: "guided_reply",
        route: "guided_flow",
        nextFlowState: common,
        guidedMessageBody: menuBody(node.prompt || "Choose an option.", node.options || []),
        activeFlowId: flowId,
        flowVersion: flow.version || 1,
        currentNode: nodeId,
        currentStep: "options",
        botStatus: "active",
        flowStatus: "active",
        caseType: "guided_flow",
        intent: "guided_flow",
        labelSuggestions: ["guided_flow"],
        privateSummary: `Guided options at ${nodeId}`,
        pendingSubmission: patch.pendingSubmission || null,
      };
    }
    if (node.type === "form") {
      return {
        guidedAction: "guided_reply",
        action: "guided_reply",
        route: "guided_flow",
        nextFlowState: common,
        guidedMessageBody: formBody(node),
        activeFlowId: flowId,
        flowVersion: flow.version || 1,
        currentNode: nodeId,
        currentStep: "form",
        botStatus: "active",
        flowStatus: "active",
        caseType: "guided_flow",
        intent: "guided_flow",
        labelSuggestions: ["guided_flow"],
        privateSummary: `Guided form at ${nodeId}`,
        pendingSubmission: patch.pendingSubmission || null,
      };
    }
    if (node.type === "upload") {
      return {
        guidedAction: "guided_reply",
        action: "guided_reply",
        route: "guided_flow",
        nextFlowState: common,
        guidedMessageBody: textBody(
          node.prompt || "Please upload the attachment here when you are ready.",
        ),
        activeFlowId: flowId,
        flowVersion: flow.version || 1,
        currentNode: nodeId,
        currentStep: "upload",
        botStatus: "active",
        flowStatus: "active",
        caseType: "guided_flow",
        intent: "guided_flow",
        labelSuggestions: ["guided_flow"],
        privateSummary: `Guided upload at ${nodeId}`,
        pendingSubmission: patch.pendingSubmission || null,
      };
    }
    if (node.type === "text") {
      if (node.next && flow.nodes[node.next]?.type === "options") {
        const nextNode = flow.nodes[node.next];
        const state = {
          ...common,
          current_node: node.next,
          mode: "options",
          step: "options",
          last_action: "show_text_with_options",
        };
        return {
          guidedAction: "guided_reply",
          action: "guided_reply",
          route: "guided_flow",
          nextFlowState: state,
          guidedMessageBody: menuBody(
            [node.content || "", nextNode.prompt || "Choose an option."].filter(Boolean).join("\n\n"),
            nextNode.options || [],
          ),
          activeFlowId: flowId,
          flowVersion: flow.version || 1,
          currentNode: node.next,
          currentStep: "options",
          botStatus: "active",
          flowStatus: "active",
          caseType: "guided_flow",
          intent: "guided_flow",
          labelSuggestions: ["guided_flow"],
          privateSummary: `Guided text+options ${nodeId}->${node.next}`,
          pendingSubmission: patch.pendingSubmission || null,
        };
      }
      const resolved = nodeId === "resolved";
      return {
        guidedAction: "guided_reply",
        action: "guided_reply",
        route: "guided_flow",
        nextFlowState: { ...common, resolved, flowStatus: resolved ? "completed" : "active" },
        guidedMessageBody: textBody(node.content || "Done."),
        activeFlowId: flowId,
        flowVersion: flow.version || 1,
        currentNode: nodeId,
        currentStep: "text",
        botStatus: resolved ? "idle" : "active",
        flowStatus: resolved ? "completed" : "active",
        caseType: "guided_flow",
        intent: "guided_flow",
        labelSuggestions: ["guided_flow"],
        privateSummary: `Guided text at ${nodeId}`,
        pendingSubmission: patch.pendingSubmission || null,
      };
    }
    if (node.type === "llm") {
      const state = {
        ...common,
        mode: "llm",
        step: "awaiting_custom",
        selected_option: patch.selected_option || baseState.selected_option || "custom",
      };
      const currentNodeId = baseState.current_node || startNodeId;
      const entries = submittedEntries(item);
      const submitted = firstSubmittedValue(entries);
      const enteringFromSelection =
        startNew || currentNodeId !== nodeId || submitted || patch.last_action === "option_selected";
      if (enteringFromSelection) {
        return {
          guidedAction: "guided_reply",
          action: "guided_reply",
          route: "guided_flow",
          nextFlowState: state,
          guidedMessageBody: textBody(
            node.prompt || "Please describe the issue in your own words.",
          ),
          activeFlowId: flowId,
          flowVersion: flow.version || 1,
          currentNode: nodeId,
          currentStep: "awaiting_custom",
          botStatus: "active",
          flowStatus: "active",
          caseType: "guided_flow",
          intent: "guided_flow",
          labelSuggestions: ["guided_flow"],
          privateSummary: "Guided LLM prompt",
          pendingSubmission: null,
        };
      }
      return {
        guidedAction: "llm",
        action: "faq",
        route: "faq",
        nextFlowState: { ...state, step: "llm_support" },
        guidedMessageBody: null,
        activeFlowId: flowId,
        flowVersion: flow.version || 1,
        currentNode: nodeId,
        currentStep: "llm_support",
        botStatus: "active",
        flowStatus: "active",
        caseType: "faq",
        intent: "faq",
        labelSuggestions: ["guided_flow"],
        privateSummary: "Guided custom question routed to FAQ",
        pendingSubmission: null,
      };
    }
    if (node.type === "human") {
      return handoff("human_requested", nodeId, {
        labels: ["human_requested"],
        state: patch,
        pendingSubmission: patch.pendingSubmission,
      });
    }
    return handoff("guided_flow_unknown_type", nodeId, {
      labels: ["guided_flow_error"],
      summary: `Unsupported guided flow node type: ${node.type}`,
    });
  }

  if (!validateFlow(flow)) {
    return handoff("guided_flow_invalid_config", flow.entry || "unknown", {
      labels: ["guided_flow_error"],
      summary: "Guided flow config is missing entry/nodes.",
    });
  }
  if ((item.guardrailRiskFlags || []).includes("human_requested")) {
    return renderNode("human");
  }

  const entries = submittedEntries(item);
  const submitted = firstSubmittedValue(entries);
  const formData = collectFormData(entries);
  const attachments = collectAttachments(item);
  const hasAttachments = attachments.length > 0;
  const currentNodeId = baseState.current_node || startNodeId;
  const currentNode = flow.nodes[currentNodeId] || flow.nodes[startNodeId] || flow.nodes[flow.entry];
  const text = String(item.userText || "").trim();
  const greetingOnly = /^(hi|hello|hey|start|help|menu)$/i.test(text) || !text;

  if (item.interactiveContentType === "form" && currentNode?.type === "form" && Object.keys(formData).length) {
    const nextFormData = { ...baseState.form_data, [currentNodeId]: formData };
    const target = currentNode.submitTarget || currentNode.next || "human";
    const pendingSubmission = {
      flow_id: flowId,
      flow_version: flow.version || 1,
      node_id: currentNodeId,
      submission_key: `${item.accountId}:${item.conversationId}:${item.messageId}:form:${currentNodeId}`,
      fields: formData,
      raw_submission: entries,
      source_message_id: String(item.messageId),
    };
    return renderNode(target, {
      form_data: nextFormData,
      path: [...baseState.path, `${currentNodeId}:submitted`],
      last_action: "form_submitted",
      pendingSubmission,
    });
  }

  if (currentNode?.type === "upload") {
    const skipped = /^(skip|no|none|nothing|nothing to attach|no attachment|no attachments)$/i.test(text);
    if (hasAttachments || (skipped && currentNode.required !== true)) {
      const normalized = normalizeAttachments(attachments);
      const nextFormData = {
        ...baseState.form_data,
        [currentNodeId]: { attachments: normalized, skipped: !hasAttachments },
      };
      const target = hasAttachments
        ? currentNode.submitTarget || currentNode.next || "human"
        : currentNode.skipTarget || currentNode.next || currentNode.submitTarget || "human";
      const pendingSubmission = {
        flow_id: flowId,
        flow_version: flow.version || 1,
        node_id: currentNodeId,
        submission_key: `${item.accountId}:${item.conversationId}:${item.messageId}:upload:${currentNodeId}`,
        fields: { attachments: normalized, skipped: !hasAttachments },
        raw_submission: attachments,
        source_message_id: String(item.messageId),
      };
      return renderNode(target, {
        form_data: nextFormData,
        path: [...baseState.path, `${currentNodeId}:${hasAttachments ? "uploaded" : "skipped"}`],
        last_action: hasAttachments ? "attachment_uploaded" : "attachment_skipped",
        pendingSubmission,
      });
    }
    return renderNode(currentNodeId, {
      last_action: "awaiting_upload",
      path: baseState.path,
    });
  }

  if (currentNode?.type === "options") {
    const option = findOption(currentNode, submitted, text);
    if (option) {
      return renderNode(option.target, {
        selected_option: option.id,
        path: [...baseState.path, option.id],
        last_action: "option_selected",
      });
    }
  }

  if (startNew || !dbState?.active_flow_id || baseState.resolved || greetingOnly) {
    return renderNode(startNodeId, { path: [], form_data: {}, selected_option: null, llm_turns: 0 });
  }
  if (currentNode?.type === "llm" && text && !submitted) {
    return renderNode(currentNodeId);
  }
  return renderNode(startNodeId, { path: [], selected_option: null });
}

export function buildLightweightCustomAttributes(result) {
  return {
    active_flow: result.activeFlowId || null,
    last_intent: result.intent || result.route || null,
    case_type: result.caseType || null,
    bot_status: result.botStatus || "idle",
    current_step: result.currentStep || result.currentNode || null,
    agent_summary: String(result.privateSummary || "").slice(0, 240),
  };
}
