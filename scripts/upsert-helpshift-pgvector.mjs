#!/usr/bin/env node
/**
 * Convert Helpshift FAQ CSV export -> RAG chunks -> Chatwoot Postgres pgvector.
 *
 * Usage:
 *   node --env-file=.env scripts/upsert-helpshift-pgvector.mjs \
 *     --faqs /path/to/en_faqs.csv \
 *     --sections /path/to/en_sections.csv
 *
 * Options:
 *   --dry-run       Print chunk stats only; no OpenAI or Postgres calls
 *   --recreate      Truncate the vector table before upsert
 *   --prune-stale   Delete vector rows whose IDs are not in this run
 */

import { loadHelpshiftChunks } from "./lib/helpshift-chunks.mjs";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_PGVECTOR_SCHEMA,
  DEFAULT_PGVECTOR_TABLE,
  createPgvectorClient,
  embedTexts,
  parsePgvectorArgs,
  summarizeChunks,
  upsertPgvectorChunks,
} from "./lib/pgvector-ingest.mjs";

async function main() {
  const args = parsePgvectorArgs(process.argv);
  const faqsPath =
    args.faqs ||
    process.env.HELPSHIFT_FAQS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_faqs.csv";
  const sectionsPath =
    args.sections ||
    process.env.HELPSHIFT_SECTIONS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_sections.csv";
  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const schema = process.env.PGVECTOR_SCHEMA || DEFAULT_PGVECTOR_SCHEMA;
  const table = process.env.PGVECTOR_TABLE || DEFAULT_PGVECTOR_TABLE;

  const { chunks, skipped, faqRows, sectionRows } = await loadHelpshiftChunks({
    faqsPath,
    sectionsPath,
  });
  if (chunks.length === 0) throw new Error("No chunks produced from Helpshift CSVs");

  console.log(`FAQs parsed:     ${faqRows.length}`);
  console.log(`Sections:        ${sectionRows.length}`);
  console.log(`Chunks:          ${chunks.length} (${skipped} FAQs skipped)`);
  console.log(`Topics:          ${JSON.stringify(summarizeChunks(chunks))}`);
  console.log(`Sample IDs:      ${chunks.slice(0, 3).map((chunk) => chunk.id).join(", ")}`);
  console.log(`Target:          ${schema}.${table}`);
  console.log(`Embedding model: ${embeddingModel}`);

  if (args.dryRun) {
    console.log("\nDry run - no OpenAI or Postgres calls.");
    return;
  }

  console.log(`\nEmbedding ${chunks.length} chunks...`);
  const embeddings = await embedTexts(chunks.map((chunk) => chunk.text), { model: embeddingModel });

  const client = createPgvectorClient();
  await client.connect();
  try {
    const result = await upsertPgvectorChunks(client, chunks, embeddings, {
      schema,
      table,
      embeddingModel,
      recreate: args.recreate,
      pruneStale: args.pruneStale,
    });
    console.log("\nDone.");
    console.log(`  Table:    ${schema}.${table}`);
    console.log(`  Upserted: ${result.upserted}`);
    console.log(`  Total:    ${result.total ?? "?"}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
