/**
 * Mirrors logic in workflows/chatwoot-support-bot.json Safety Gate Code node.
 * Update both if rules change.
 */

export function evaluateSafety({ agent, upstream, httpError }) {
  let merged = {
    answer: null,
    confidence: 0,
    needs_human: true,
    risk_flags: ["tool_failed"],
    labels: ["bot_escalated"],
    private_summary: "LLM request failed or malformed response",
  };

  if (!httpError && agent && typeof agent === "object") {
    merged = { ...merged, ...agent };
  }

  const handoffFlags = [
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
  ];

  const risk = Array.isArray(merged.risk_flags) ? merged.risk_flags : [];
  const confidence = typeof merged.confidence === "number" ? merged.confidence : 0;
  const needsHuman = merged.needs_human === true;
  const answer = typeof merged.answer === "string" ? merged.answer.trim() : "";

  const risky = risk.some((f) => handoffFlags.includes(f));
  const shouldHandoff =
    needsHuman || confidence < 0.7 || risky || !answer || answer.length > 1200;

  const action = shouldHandoff ? "handoff" : "reply";
  const summary =
    typeof merged.private_summary === "string" && merged.private_summary.trim()
      ? merged.private_summary.trim()
      : "No summary provided by model.";

  return {
    action,
    confidence,
    riskFlags: risk,
    intent: typeof merged.intent === "string" ? merged.intent : "unknown",
    knowledgeUsed: Array.isArray(merged.knowledge_used) ? merged.knowledge_used : [],
    publicAnswer: answer,
    labelSuggestions: Array.isArray(merged.labels) ? merged.labels : [],
    privateSummary: [
      summary,
      `action=${action}`,
      `confidence=${confidence}`,
      `risk_flags=${risk.join(",")}`,
    ].join(" | "),
    upstream,
  };
}

export function nextFailureState({ conversationId, previous = {}, safety }) {
  const key = String(conversationId);
  const current = Number(previous[key] || 0);
  const confidence = typeof safety.confidence === "number" ? safety.confidence : 0;
  const failed = safety.action === "handoff" || confidence < 0.75;
  const count = failed ? current + 1 : 0;
  return {
    counts: { ...previous, [key]: count },
    failedTurnCount: count,
    forceHandoff: count >= 2,
    forceEscalate: count >= 2,
  };
}
