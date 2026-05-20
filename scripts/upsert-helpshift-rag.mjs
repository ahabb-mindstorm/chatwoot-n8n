#!/usr/bin/env node
/**
 * Convert Helpshift FAQ CSV export → RAG chunks → Pinecone upsert.
 *
 * Usage:
 *   node --env-file=.env scripts/upsert-helpshift-rag.mjs \
 *     --faqs /path/to/en_faqs.csv \
 *     --sections /path/to/en_sections.csv
 *
 * Options:
 *   --recreate     Delete and recreate the index before upsert
 *   --dry-run      Print chunk stats only, no Pinecone/OpenAI calls
 */

import { Pinecone } from "@pinecone-database/pinecone";

import { loadHelpshiftChunks } from "./lib/helpshift-chunks.mjs";

const DEFAULT_INDEX = "pro-golf-support";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 32;

function parseArgs(argv) {
  const out = {
    faqs: null,
    sections: null,
    recreate: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--recreate") out.recreate = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--faqs" && argv[i + 1]) out.faqs = argv[++i];
    else if (a === "--sections" && argv[i + 1]) out.sections = argv[++i];
  }
  return out;
}

async function embedTexts(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureIndex(pc, indexName, recreate) {
  const existing = await pc.listIndexes();
  const names = (existing.indexes || []).map((i) => i.name);
  const found = names.includes(indexName);

  if (found && recreate) {
    console.log(`Deleting index ${indexName}...`);
    await pc.deleteIndex(indexName);
    await sleep(5000);
  } else if (found) {
    console.log(`Index ${indexName} already exists — upserting into it.`);
    return;
  }

  console.log(`Creating index ${indexName} (dim=${EMBEDDING_DIM}, cosine)...`);
  await pc.createIndex({
    name: indexName,
    dimension: EMBEDDING_DIM,
    metric: "cosine",
    spec: { serverless: { cloud: "aws", region: "us-east-1" } },
  });

  for (let attempt = 0; attempt < 60; attempt++) {
    const desc = await pc.describeIndex(indexName);
    if (desc.status?.ready) break;
    await sleep(2000);
  }
}

async function upsertChunks(pc, indexName, namespace, chunks) {
  const index = pc.index(indexName);
  const ns = namespace ? index.namespace(namespace) : index;

  const texts = chunks.map((c) => c.text);
  console.log(`Embedding ${chunks.length} chunks with ${EMBEDDING_MODEL}...`);
  const embeddings = await embedTexts(texts);

  const records = chunks.map((chunk, i) => ({
    id: chunk.id,
    values: embeddings[i],
    metadata: {
      doc_id: chunk.id,
      topic: chunk.topic,
      title: chunk.title,
      body: chunk.body,
      text: chunk.text,
      feature: chunk.feature,
      faq_id: chunk.faq_id,
      source: chunk.source,
      keywords: chunk.keywords.join(", "),
      game_contexts: chunk.game_contexts,
      tips: chunk.tips,
    },
  }));

  console.log(`Upserting ${records.length} vectors...`);
  for (let i = 0; i < records.length; i += 100) {
    await ns.upsert(records.slice(i, i + 100));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const faqsPath =
    args.faqs ||
    process.env.HELPSHIFT_FAQS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_faqs.csv";
  const sectionsPath =
    args.sections ||
    process.env.HELPSHIFT_SECTIONS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_sections.csv";

  const { chunks, skipped, faqRows, sectionRows } = await loadHelpshiftChunks({
    faqsPath,
    sectionsPath,
  });
  if (chunks.length === 0) throw new Error("No chunks produced from Helpshift CSVs");

  const byTopic = {};
  for (const c of chunks) {
    byTopic[c.topic] = (byTopic[c.topic] || 0) + 1;
  }

  console.log(`FAQs parsed:     ${faqRows.length}`);
  console.log(`Sections:        ${sectionRows.length}`);
  console.log(`Chunks:          ${chunks.length} (${skipped} FAQs skipped)`);
  console.log(`Topics:          ${JSON.stringify(byTopic)}`);
  console.log(`Sample IDs:      ${chunks.slice(0, 3).map((c) => c.id).join(", ")}`);

  if (args.dryRun) {
    console.log("\nDry run — no upsert.");
    return;
  }

  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error("PINECONE_API_KEY is required");

  const indexName = process.env.PINECONE_INDEX?.trim() || DEFAULT_INDEX;
  const namespace = process.env.PINECONE_NAMESPACE?.trim() || "";

  const pc = new Pinecone({ apiKey });
  await ensureIndex(pc, indexName, args.recreate);
  await upsertChunks(pc, indexName, namespace, chunks);

  const stats = await pc.index(indexName).describeIndexStats();
  console.log("\nDone.");
  console.log(`  Index:     ${indexName}`);
  console.log(`  Namespace: ${namespace || "(default)"}`);
  console.log(`  Upserted:  ${chunks.length}`);
  console.log(`  Total:     ${stats.totalRecordCount ?? "?"}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
