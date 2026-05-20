/**
 * RAG FAQ evaluation for Postgres-backed bot workflow.
 */

export function normalizeRetrievedChunks(items = []) {
  const chunks = [];
  for (const item of items) {
    const json = item.json || item || {};
    const doc = json.document || json;
    const meta = doc.metadata || json.metadata || {};
    const score =
      typeof json.score === "number"
        ? json.score
        : typeof meta.score === "number"
          ? meta.score
          : 0;
    const id = meta.doc_id || meta.id || doc.id || json.id || `chunk-${chunks.length + 1}`;
    chunks.push({
      id: String(id),
      score,
      title: meta.title || doc.title || meta.topic || id,
      body:
        typeof doc.pageContent === "string"
          ? doc.pageContent
          : typeof doc.text === "string"
            ? doc.text
            : typeof meta.body === "string"
              ? meta.body
              : "",
      topic: meta.topic || null,
      metadata: meta,
    });
  }
  chunks.sort((a, b) => b.score - a.score);
  return chunks;
}

export function evaluateRetrieval(chunks, env = {}) {
  const minScore = Number(env.RAG_MIN_SCORE || 0.72);
  const maxScore = chunks.reduce(
    (max, chunk) => Math.max(max, typeof chunk.score === "number" ? chunk.score : 0),
    0,
  );
  return {
    inScope: chunks.length > 0 && maxScore >= minScore,
    maxScore,
    minScore,
    chunkIds: chunks.map((chunk) => chunk.id),
    chunkCount: chunks.length,
  };
}

export function buildFaqPrompt({ userText, chunks, transcript }) {
  const context = chunks
    .slice(0, 5)
    .map((chunk, index) => `[${index + 1}] ${chunk.title}\n${chunk.body}`)
    .join("\n\n");
  return [
    "Answer ONLY using the support knowledge below.",
    "If the knowledge does not cover the question, respond with NEEDS_HUMAN.",
    "Keep the answer under 900 characters.",
    "",
    "Customer message:",
    userText,
    "",
    "Recent transcript:",
    transcript || "(empty)",
    "",
    "Knowledge:",
    context || "(none)",
  ].join("\n");
}

export function evaluateFaqAnswer({ answer, retrieval, riskFlags = [] }) {
  const text = String(answer || "").trim();
  const risky = riskFlags.some((flag) =>
    ["human_requested", "credential_shared", "billing_dispute", "legal", "security", "data_deletion", "tool_failed"].includes(
      flag,
    ),
  );
  const needsHuman =
    risky ||
    !retrieval?.inScope ||
    !text ||
    text.length > 900 ||
    /NEEDS_HUMAN/i.test(text);
  return {
    action: needsHuman ? "handoff" : "reply",
    publicAnswer: needsHuman ? "" : text,
    route: needsHuman ? "human_handoff" : "faq",
    intent: "faq",
    caseType: "faq",
  };
}
