import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PGVECTOR_SCHEMA,
  DEFAULT_PGVECTOR_TABLE,
  EMBEDDING_DIMENSION,
  metadataForChunk,
  parsePgvectorArgs,
  qualifiedTableName,
  summarizeChunks,
  vectorLiteral,
} from "../scripts/lib/pgvector-ingest.mjs";

test("pgvector args parse dry-run, recreate, prune-stale, and CSV paths", () => {
  const args = parsePgvectorArgs([
    "node",
    "script",
    "--dry-run",
    "--recreate",
    "--prune-stale",
    "--faqs",
    "/tmp/faqs.csv",
    "--sections",
    "/tmp/sections.csv",
  ]);

  assert.equal(args.dryRun, true);
  assert.equal(args.recreate, true);
  assert.equal(args.pruneStale, true);
  assert.equal(args.faqs, "/tmp/faqs.csv");
  assert.equal(args.sections, "/tmp/sections.csv");
});

test("pgvector table identifier helpers reject unsafe names", () => {
  assert.equal(
    qualifiedTableName({ schema: DEFAULT_PGVECTOR_SCHEMA, table: DEFAULT_PGVECTOR_TABLE }),
    '"progolf_support"."progolf_faq_vectors"',
  );
  assert.throws(
    () => qualifiedTableName({ schema: "public;drop", table: "progolf_faq_vectors" }),
    /Invalid schema/,
  );
});

test("pgvector vector literal enforces 1536 dimensions", () => {
  const values = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => index / 1000);
  const literal = vectorLiteral(values);

  assert.ok(literal.startsWith("[0,0.001,0.002"));
  assert.ok(literal.endsWith("1.535]"));
  assert.throws(() => vectorLiteral([1, 2, 3]), /1536 dimensions/);
});

test("pgvector metadata preserves FAQ grounding fields", () => {
  const metadata = metadataForChunk(
    {
      id: "helpshift-faq-123--coins",
      faq_id: "123",
      title: "What are coins for?",
      topic: "gameplay",
      feature: "currency",
      source: "helpshift",
      keywords: ["coins", "entry"],
      game_contexts: ["tournament"],
      tips: ["Coins can enter some tournaments."],
    },
    "text-embedding-3-small",
  );

  assert.deepEqual(metadata, {
    doc_id: "helpshift-faq-123--coins",
    faq_id: "123",
    title: "What are coins for?",
    topic: "gameplay",
    feature: "currency",
    source: "helpshift",
    keywords: ["coins", "entry"],
    game_contexts: ["tournament"],
    tips: ["Coins can enter some tournaments."],
    embedding_model: "text-embedding-3-small",
  });
});

test("pgvector chunk summary groups by topic", () => {
  assert.deepEqual(
    summarizeChunks([{ topic: "gameplay" }, { topic: "gameplay" }, { topic: "payments" }, {}]),
    { gameplay: 2, payments: 1, unknown: 1 },
  );
});
