#!/usr/bin/env node
/**
 * Sync published Chatwoot Help Center articles into progolf_support.progolf_faq_vectors.
 */

import {
  articlesToChunks,
  buildScopedChatwootSyncSql,
  metadataForArticleChunk,
  summarizeArticleChunks,
} from "./lib/chatwoot-article-chunks.mjs";
import {
  fetchPublishedArticlesFromApi,
  resolveChatwootApiEnv,
} from "./lib/chatwoot-help-center-api.mjs";
import {
  createPgvectorClient,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_PGVECTOR_SCHEMA,
  DEFAULT_PGVECTOR_TABLE,
  embedTexts,
} from "./lib/pgvector-ingest.mjs";

function parseArgs(argv) {
  const out = { dryRun: false, pruneStale: true };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--no-prune-stale") out.pruneStale = false;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const { baseUrl, token, accountId, portalSlug } = resolveChatwootApiEnv();
  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const schema = process.env.PGVECTOR_SCHEMA || DEFAULT_PGVECTOR_SCHEMA;
  const table = process.env.PGVECTOR_TABLE || DEFAULT_PGVECTOR_TABLE;

  if (!accountId) throw new Error("CHATWOOT_ACCOUNT_ID is required");

  const articles = await fetchPublishedArticlesFromApi({
    baseUrl,
    token,
    accountId,
    portalSlug,
  });

  const client = createPgvectorClient();
  await client.connect();
  try {
    const { chunks, skipped } = articlesToChunks(articles);

    console.log(`Articles fetched: ${articles.length}`);
    console.log(`Chunks:           ${chunks.length} (${skipped} articles skipped)`);
    console.log(`Topics:           ${JSON.stringify(summarizeArticleChunks(chunks))}`);
    console.log(`Sample IDs:       ${chunks.slice(0, 3).map((chunk) => chunk.id).join(", ")}`);
    console.log(`Target:           ${schema}.${table}`);
    console.log(`Embedding model:  ${embeddingModel}`);

    if (chunks.length === 0) {
      console.log("\nNo chunks produced. Nothing to upsert.");
      return;
    }

    if (args.dryRun) {
      console.log("\nDry run - no OpenAI or pgvector writes.");
      return;
    }

    console.log(`\nEmbedding ${chunks.length} chunks...`);
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text), { model: embeddingModel });
    const rows = chunks.map((chunk, index) => ({
      id: chunk.id,
      text: chunk.text,
      metadata: metadataForArticleChunk(chunk, embeddingModel),
      embedding: embeddings[index],
    }));

    const sync = buildScopedChatwootSyncSql(rows, { schema, table, pruneStale: args.pruneStale });
    const result = await client.query(sync.query);
    const summary = result.at(-1)?.rows?.[0] || {};

    console.log("\nDone.");
    console.log(`  Upserted:       ${sync.upserted_rows}`);
    console.log(`  Total rows:     ${summary.total_rows ?? "?"}`);
    console.log(`  Chatwoot rows:  ${summary.chatwoot_rows ?? "?"}`);
    console.log(`  Playbook rows:  ${summary.playbook_rows ?? "?"}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
