import { Client } from "pg";

export const DEFAULT_PGVECTOR_SCHEMA = "progolf_support";
export const DEFAULT_PGVECTOR_TABLE = "progolf_faq_vectors";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSION = 1536;
export const OPENAI_EMBEDDING_BATCH_SIZE = 32;

export function parsePgvectorArgs(argv) {
  const out = {
    faqs: null,
    sections: null,
    recreate: false,
    pruneStale: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--recreate") out.recreate = true;
    else if (arg === "--prune-stale") out.pruneStale = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--faqs" && argv[i + 1]) out.faqs = argv[++i];
    else if (arg === "--sections" && argv[i + 1]) out.sections = argv[++i];
  }

  return out;
}

export function sqlIdentifier(value, label = "identifier") {
  const clean = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) {
    throw new Error(`Invalid ${label}: ${clean || "(empty)"}`);
  }
  return `"${clean.replace(/"/g, '""')}"`;
}

export function qualifiedTableName({ schema, table }) {
  return `${sqlIdentifier(schema, "schema")}.${sqlIdentifier(table, "table")}`;
}

export function vectorLiteral(values) {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSION) {
    throw new Error(`Expected embedding with ${EMBEDDING_DIMENSION} dimensions`);
  }

  const numbers = values.map((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Invalid embedding value at index ${index}`);
    }
    return number;
  });

  return `[${numbers.join(",")}]`;
}

export function metadataForChunk(chunk, embeddingModel) {
  return {
    doc_id: chunk.id,
    faq_id: chunk.faq_id || "",
    title: chunk.title || "",
    topic: chunk.topic || "",
    feature: chunk.feature || "",
    source: chunk.source || "helpshift",
    keywords: Array.isArray(chunk.keywords) ? chunk.keywords : [],
    game_contexts: Array.isArray(chunk.game_contexts) ? chunk.game_contexts : [],
    tips: Array.isArray(chunk.tips) ? chunk.tips : [],
    embedding_model: embeddingModel,
  };
}

export function summarizeChunks(chunks) {
  const byTopic = {};
  for (const chunk of chunks) {
    const topic = chunk.topic || "unknown";
    byTopic[topic] = (byTopic[topic] || 0) + 1;
  }
  return byTopic;
}

export async function embedTexts(texts, {
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  batchSize = OPENAI_EMBEDDING_BATCH_SIZE,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed (${res.status}): ${await res.text()}`);
    }
    const json = await res.json();
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    vectors.push(...sorted.map((row) => row.embedding));
  }
  return vectors;
}

export function createPgvectorClient({
  connectionString =
    process.env.CHATWOOT_PGVECTOR_DATABASE_URL ||
    process.env.PGVECTOR_DATABASE_URL,
  ssl =
    /^(true|1|require)$/i.test(process.env.CHATWOOT_PGVECTOR_DB_SSL || "") ||
    /^(true|1|require)$/i.test(process.env.PGVECTOR_DB_SSL || ""),
  rejectUnauthorized =
    !/^(false|0)$/i.test(process.env.CHATWOOT_PGVECTOR_DB_SSL_REJECT_UNAUTHORIZED || "") &&
    !/^(false|0)$/i.test(process.env.PGVECTOR_DB_SSL_REJECT_UNAUTHORIZED || ""),
} = {}) {
  if (!connectionString) {
    throw new Error("CHATWOOT_PGVECTOR_DATABASE_URL is required");
  }

  return new Client({
    connectionString,
    ...(ssl ? { ssl: { rejectUnauthorized } } : {}),
  });
}

export async function assertVectorTableExists(client, { schema, table }) {
  const relation = `${schema}.${table}`;
  const result = await client.query("SELECT to_regclass($1) AS relation", [relation]);
  if (!result.rows[0]?.relation) {
    throw new Error(`PGVector table ${relation} does not exist. Apply migrations/002_progolf_pgvector.sql first.`);
  }
}

export async function upsertPgvectorChunks(client, chunks, embeddings, {
  schema = process.env.PGVECTOR_SCHEMA || DEFAULT_PGVECTOR_SCHEMA,
  table = process.env.PGVECTOR_TABLE || DEFAULT_PGVECTOR_TABLE,
  embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  recreate = false,
  pruneStale = false,
} = {}) {
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) does not match embedding count (${embeddings.length})`);
  }

  const tableName = qualifiedTableName({ schema, table });
  await assertVectorTableExists(client, { schema, table });

  await client.query("BEGIN");
  try {
    if (recreate) {
      await client.query(`TRUNCATE TABLE ${tableName}`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const metadata = metadataForChunk(chunk, embeddingModel);
      await client.query(
        `INSERT INTO ${tableName} (id, text, metadata, embedding)
         VALUES ($1, $2, $3::jsonb, $4::vector)
         ON CONFLICT (id) DO UPDATE SET
           text = EXCLUDED.text,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding`,
        [
          chunk.id,
          chunk.text,
          JSON.stringify(metadata),
          vectorLiteral(embeddings[i]),
        ],
      );
    }

    if (pruneStale && chunks.length > 0) {
      await client.query(
        `DELETE FROM ${tableName} WHERE NOT (id = ANY($1::text[]))`,
        [chunks.map((chunk) => chunk.id)],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const count = await client.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
  return { upserted: chunks.length, total: count.rows[0]?.count ?? null };
}
