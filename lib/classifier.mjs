/**
 * Classifier output validation for Postgres-backed bot workflow.
 */

export const CLASSIFIER_ROUTES = ["guided_flow", "faq", "human_handoff", "clarification"];

export const CLASSIFIER_JSON_SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: CLASSIFIER_ROUTES },
    intent: { type: "string" },
    case_type: { type: "string" },
    confidence: { type: "number" },
    risk_flags: { type: "array", items: { type: "string" } },
    flow_id: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    requires_human: { type: "boolean" },
  },
  required: ["route", "intent", "confidence", "requires_human"],
};

export function parseClassifierOutput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw, parseFailed: false };
  }
  try {
    const text = String(raw || "")
      .trim()
      .replace(/^```json\s*|\s*```$/g, "");
    return { ok: true, value: JSON.parse(text), parseFailed: false };
  } catch {
    return { ok: false, value: null, parseFailed: true };
  }
}

export function validateClassifier(value, env = {}) {
  const minConfidence = Number(env.CLASSIFIER_MIN_CONFIDENCE || 0.65);
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "missing_classifier", route: "human_handoff" };
  }
  const route = String(value.route || "").toLowerCase();
  if (!CLASSIFIER_ROUTES.includes(route)) {
    return { ok: false, reason: "invalid_route", route: "human_handoff" };
  }
  const confidence = typeof value.confidence === "number" ? value.confidence : 0;
  if (confidence < minConfidence) {
    return { ok: false, reason: "low_confidence", route: "human_handoff", classifier: value };
  }
  if (value.requires_human === true) {
    return { ok: false, reason: "requires_human", route: "human_handoff", classifier: value };
  }
  return {
    ok: true,
    route,
    classifier: {
      route,
      intent: String(value.intent || route),
      case_type: String(value.case_type || "general"),
      confidence,
      risk_flags: Array.isArray(value.risk_flags) ? value.risk_flags : [],
      flow_id: String(value.flow_id || env.DEFAULT_GUIDED_FLOW_ID || "support_main"),
      labels: Array.isArray(value.labels) ? value.labels : [],
      summary: String(value.summary || ""),
      requires_human: false,
    },
  };
}

export function mergeClassifierRisk(classifier, guardrailRiskFlags = []) {
  const risk = new Set([
    ...(Array.isArray(classifier?.risk_flags) ? classifier.risk_flags : []),
    ...guardrailRiskFlags,
  ]);
  const handoffFlags = [
    "human_requested",
    "credential_shared",
    "billing_dispute",
    "legal",
    "security",
    "data_deletion",
    "tool_failed",
  ];
  if ([...risk].some((flag) => handoffFlags.includes(flag))) {
    return { ok: false, reason: "risk_flags", route: "human_handoff", classifier };
  }
  return { ok: true, route: classifier.route, classifier, riskFlags: [...risk] };
}
