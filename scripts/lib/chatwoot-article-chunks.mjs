import {
  extractKeywords,
  extractTips,
  htmlToText,
  inferGameContexts,
  inferTopic,
  MAX_CHUNK_CHARS,
  slugify,
} from "./helpshift-chunks.mjs";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_PGVECTOR_SCHEMA,
  DEFAULT_PGVECTOR_TABLE,
  metadataForChunk,
  qualifiedTableName,
  vectorLiteral,
} from "./pgvector-ingest.mjs";

export const CHATWOOT_FAQ_SOURCE = "chatwoot";

export const CATEGORY_TOPIC = {
  Account: { topic: "account", feature: "account" },
  Payments: { topic: "payments", feature: "payments" },
  Gameplay: { topic: "gameplay", feature: "gameplay" },
  "Game Modes": { topic: "game_modes", feature: "game_modes" },
  Equipment: { topic: "equipment", feature: "equipment" },
  LootBags: { topic: "loot_bags", feature: "loot_bags" },
  "Golf Pass": { topic: "season_pass", feature: "season_pass" },
  Shop: { topic: "shop", feature: "shop" },
  Personalization: { topic: "personalization", feature: "personalization" },
  General: { topic: "general", feature: "general" },
};

function sqlString(value) {
  return `'${String(value ?? "").replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function splitLongBody(title, body) {
  if (body.length <= MAX_CHUNK_CHARS) {
    return [{ part: "full", text: `# ${title}\n\n${body}` }];
  }

  const parts = [];
  const paragraphs = body.split(/\n\n+/);
  let buffer = `# ${title}\n\n`;
  let partIndex = 0;

  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_CHARS && buffer.length > title.length + 4) {
      parts.push({ part: `p${partIndex++}`, text: buffer.trim() });
      buffer = `# ${title} (continued)\n\n${para}\n\n`;
    } else {
      buffer += `${para}\n\n`;
    }
  }
  if (buffer.trim()) parts.push({ part: `p${partIndex}`, text: buffer.trim() });
  return parts;
}

export function topicFromCategory(categoryName, title, body) {
  const normalized = String(categoryName || "").trim();
  if (normalized && CATEGORY_TOPIC[normalized]) {
    return CATEGORY_TOPIC[normalized];
  }
  return inferTopic(title, body);
}

export function articlesToChunks(articles) {
  const chunks = [];
  let skipped = 0;

  for (const row of articles) {
    const faqId = String(row.faq_id || row.id || "").trim();
    const title = String(row.title || "").trim();
    const plainBody = htmlToText(row.content);
    if (!faqId || !title || !plainBody) {
      skipped++;
      continue;
    }

    const slug = slugify(title) || "faq";
    const { topic, feature } = topicFromCategory(row.category_name, title, plainBody);
    const game_contexts = inferGameContexts(title, plainBody);
    const tips = extractTips(plainBody);
    const keywords = extractKeywords(title, plainBody);
    const parts = splitLongBody(title, plainBody);

    for (const { part, text } of parts) {
      const id =
        parts.length === 1
          ? `chatwoot-faq-${faqId}--${slug}`
          : `chatwoot-faq-${faqId}--${slug}--${part}`;

      chunks.push({
        id,
        title,
        topic,
        feature,
        text,
        faq_id: faqId,
        slug,
        portal_slug: String(row.portal_slug || "").trim(),
        category_name: String(row.category_name || "").trim(),
        keywords,
        game_contexts,
        tips,
        source: CHATWOOT_FAQ_SOURCE,
      });
    }
  }

  return { chunks, skipped };
}

export function metadataForArticleChunk(chunk, embeddingModel = DEFAULT_EMBEDDING_MODEL) {
  return {
    ...metadataForChunk(chunk, embeddingModel),
    portal_slug: chunk.portal_slug || "",
    category_name: chunk.category_name || "",
    slug: chunk.slug || "",
  };
}

export function buildScopedChatwootSyncSql(rows, {
  schema = DEFAULT_PGVECTOR_SCHEMA,
  table = DEFAULT_PGVECTOR_TABLE,
  source = CHATWOOT_FAQ_SOURCE,
  pruneStale = true,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("No rows provided for pgvector sync SQL");
  }

  const tableName = qualifiedTableName({ schema, table });
  const valueTuples = rows.map((row) => {
    return `(${[
      sqlString(row.id),
      sqlString(row.text),
      sqlString(JSON.stringify(row.metadata)) + "::jsonb",
      sqlString(vectorLiteral(row.embedding)) + "::vector",
    ].join(", ")})`;
  });
  const idTuples = rows.map((row) => `(${sqlString(row.id)})`);

  const statements = [
    "BEGIN",
    pruneStale
      ? `DELETE FROM ${tableName} target
WHERE COALESCE(target.metadata->>'source', '') = ${sqlString(source)}
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES ${idTuples.join(",\n")}) AS incoming(id)
    WHERE incoming.id = target.id
  )`
      : "",
    `INSERT INTO ${tableName} (id, text, metadata, embedding) VALUES
${valueTuples.join(",\n")}
ON CONFLICT (id) DO UPDATE SET
  text = EXCLUDED.text,
  metadata = EXCLUDED.metadata,
  embedding = EXCLUDED.embedding,
  updated_at = NOW()`,
    "COMMIT",
    `SELECT
  COUNT(*)::int AS total_rows,
  COUNT(*) FILTER (WHERE metadata->>'source' = ${sqlString(source)})::int AS chatwoot_rows,
  COUNT(*) FILTER (WHERE COALESCE(metadata->>'doc_type', 'faq') = 'support_playbook')::int AS playbook_rows
FROM ${tableName}`,
  ].filter(Boolean);

  return {
    query: `${statements.join(";\n")};`,
    upserted_rows: rows.length,
    target_table: `${schema}.${table}`,
    prune_stale: pruneStale,
    source,
  };
}

export function summarizeArticleChunks(chunks) {
  const byTopic = {};
  for (const chunk of chunks) {
    const topic = chunk.topic || "unknown";
    byTopic[topic] = (byTopic[topic] || 0) + 1;
  }
  return byTopic;
}
