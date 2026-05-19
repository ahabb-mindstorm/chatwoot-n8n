/**
 * Mirrors logic in workflows/chatwoot-rag-guided-bot.json RAG scope Code nodes.
 * Update both if rules change.
 */

/**
 * Normalize Pinecone / vector-store node output into scored chunks.
 * @param {unknown[]} items - n8n items from vector store load
 */
export function normalizeRetrievedChunks(items = []) {
  const chunks = [];
  for (const item of items) {
    const json = item?.json ?? item;
    if (!json || typeof json !== "object") continue;

    const doc = json.document ?? json;
    const meta = doc.metadata ?? json.metadata ?? {};
    const score =
      typeof json.score === "number"
        ? json.score
        : typeof meta.score === "number"
          ? meta.score
          : 0;

    const id =
      meta.doc_id ||
      meta.id ||
      doc.id ||
      json.id ||
      `chunk-${chunks.length + 1}`;

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
      game_contexts: Array.isArray(meta.game_contexts) ? meta.game_contexts : [],
      tips: Array.isArray(meta.tips) ? meta.tips : [],
      metadata: meta,
    });
  }

  chunks.sort((a, b) => b.score - a.score);
  return chunks;
}

/**
 * @param {{ chunks?: Array<{ score?: number, id?: string }>, minScore?: number }}
 */
export function evaluateRetrieval({ chunks = [], minScore = 0.72 }) {
  const list = Array.isArray(chunks) ? chunks : [];
  const maxScore = list.reduce(
    (max, chunk) => Math.max(max, typeof chunk.score === "number" ? chunk.score : 0),
    0,
  );
  const chunkIds = list.map((c) => c.id).filter(Boolean);
  const inScope = list.length > 0 && maxScore >= minScore;

  return {
    inScope,
    maxScore,
    chunkIds,
    chunkCount: list.length,
    minScore,
  };
}
