#!/usr/bin/env node
/**
 * Create Pinecone index (if missing) and upsert rag/*.md chunks.
 * Metadata matches workflows/chatwoot-rag-guided-bot.json + lib/ragScope.mjs.
 *
 * Usage: node --env-file=.env scripts/upsert-rag.mjs [--recreate]
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pinecone } from "@pinecone-database/pinecone";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RAG_DIR = join(ROOT, "rag");
const DEFAULT_INDEX = "pro-golf-support";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 32;

/** Default game_contexts per doc (planner option sources). */
const CONTEXTS_BY_DOC = {
  "00-reward-system-overview": [
    "main_screen",
    "tournament",
    "news_inbox",
    "loot_bags",
    "daily_reward",
  ],
  "01-home-screen-and-pending-rewards": ["main_screen", "home"],
  "02-tournaments-and-leaderboard-rewards": ["tournament"],
  "03-loot-bags": ["main_screen", "loot_bags", "season_pass", "mini_game"],
  "04-daily-rewards": ["daily_reward"],
  "05-news-and-inbox": ["news_inbox"],
  "06-best-shot-top-shot": ["tournament", "best_shot"],
  "07-mini-games-pro-shot-speed-putt": ["mini_game", "main_screen"],
  "08-season-pass": ["season_pass"],
  "09-season-events-and-qualifiers": ["season_event", "news_inbox"],
  "10-challenges": ["challenge"],
  "11-career-progression-level-rewards": ["career"],
  "12-shop-payments-referrals": ["shop"],
  "99-troubleshooting-lost-rewards": [
    "main_screen",
    "tournament",
    "news_inbox",
    "loot_bags",
    "daily_reward",
    "mini_game",
    "season_pass",
    "season_event",
    "challenge",
    "career",
    "shop",
  ],
};

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function extractTips(sectionBody) {
  const tips = [];
  for (const line of sectionBody.split("\n")) {
    const support = line.match(/\*\*Support script:\*\*\s*(.+)/i);
    if (support) tips.push(support[1].trim());
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet && /check|claim|open|home|inbox|tournament/i.test(bullet[1])) {
      tips.push(bullet[1].trim());
    }
  }
  return [...new Set(tips)].slice(0, 5);
}

function chunkMarkdown(fileStem, meta, body) {
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || fileStem;
  const sections = [];
  const parts = body.split(/\n(?=## )/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const isSubsection = trimmed.startsWith("## ");
    const title = isSubsection
      ? trimmed.match(/^##\s+(.+)$/m)?.[1]?.trim() || h1
      : h1;
    const sectionSlug = slugify(title) || "intro";
    const docId = `${fileStem}--${sectionSlug}`;
    const text = trimmed;
    const keywords = (meta.keywords || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    sections.push({
      id: docId,
      title,
      topic: meta.topic || fileStem,
      body: text,
      text,
      feature: fileStem,
      keywords,
      game_contexts: CONTEXTS_BY_DOC[fileStem] || [],
      tips: extractTips(text),
    });
  }

  return sections;
}

async function loadChunks() {
  const files = (await readdir(RAG_DIR))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  const chunks = [];
  for (const file of files) {
    const raw = await readFile(join(RAG_DIR, file), "utf8");
    const stem = basename(file, ".md");
    const { meta, body } = parseFrontMatter(raw);
    chunks.push(...chunkMarkdown(stem, meta, body));
  }
  return chunks;
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
      const err = await res.text();
      throw new Error(`OpenAI embeddings failed (${res.status}): ${err}`);
    }
    const json = await res.json();
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    vectors.push(...sorted.map((row) => row.embedding));
  }
  return vectors;
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

  console.log(`Creating index ${indexName} (dim=${EMBEDDING_DIM}, cosine, aws/us-east-1)...`);
  await pc.createIndex({
    name: indexName,
    dimension: EMBEDDING_DIM,
    metric: "cosine",
    spec: { serverless: { cloud: "aws", region: "us-east-1" } },
  });

  console.log("Waiting for index to be ready...");
  for (let attempt = 0; attempt < 60; attempt++) {
    const desc = await pc.describeIndex(indexName);
    if (desc.status?.ready) break;
    await sleep(2000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function upsertChunks(pc, indexName, namespace, chunks) {
  const index = pc.index(indexName);
  const ns = namespace ? index.namespace(namespace) : index;

  const texts = chunks.map((c) => c.text);
  console.log(`Embedding ${chunks.length} chunks with ${EMBEDDING_MODEL}...`);
  const embeddings = await embedTexts(texts);

  console.log(`Upserting ${chunks.length} vectors...`);
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
      keywords: chunk.keywords.join(", "),
      game_contexts: chunk.game_contexts,
      tips: chunk.tips,
    },
  }));

  for (let i = 0; i < records.length; i += 100) {
    await ns.upsert(records.slice(i, i + 100));
  }
}

async function main() {
  const recreate = process.argv.includes("--recreate");
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error("PINECONE_API_KEY is required");

  const indexName = process.env.PINECONE_INDEX?.trim() || DEFAULT_INDEX;
  const namespace = process.env.PINECONE_NAMESPACE?.trim() || "";

  const chunks = await loadChunks();
  if (chunks.length === 0) throw new Error("No chunks found in rag/");

  console.log(`Loaded ${chunks.length} chunks from rag/`);

  const pc = new Pinecone({ apiKey });
  await ensureIndex(pc, indexName, recreate);
  await upsertChunks(pc, indexName, namespace, chunks);

  const stats = await pc.index(indexName).describeIndexStats();
  console.log("\nDone.");
  console.log(`  Index:     ${indexName}`);
  console.log(`  Namespace: ${namespace || "(default)"}`);
  console.log(`  Chunks:    ${chunks.length}`);
  console.log(`  Vectors:   ${stats.totalRecordCount ?? "?"}`);

  if (!process.env.PINECONE_INDEX?.trim()) {
    console.log(`\nSet in .env: PINECONE_INDEX=${indexName}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
