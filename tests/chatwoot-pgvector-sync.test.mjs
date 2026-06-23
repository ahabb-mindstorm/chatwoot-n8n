import assert from "node:assert/strict";
import { test } from "node:test";

import {
  articlesToChunks,
  buildScopedChatwootSyncSql,
  CHATWOOT_FAQ_SOURCE,
  metadataForArticleChunk,
  topicFromCategory,
} from "../scripts/lib/chatwoot-article-chunks.mjs";
import {
  activePortalSlugsFromList,
  isActivePortal,
  isPublishedArticle,
  normalizeArticleRecord,
} from "../scripts/lib/chatwoot-help-center-api.mjs";
import { EMBEDDING_DIMENSION } from "../scripts/lib/pgvector-ingest.mjs";

test("active portal filter excludes archived help centers", () => {
  assert.equal(isActivePortal({ slug: "withdrawl", archived: false }), true);
  assert.equal(isActivePortal({ slug: "legacy", archived: true }), false);
  assert.equal(isActivePortal({ slug: "default" }), true);

  assert.deepEqual(
    activePortalSlugsFromList([
      { slug: "withdrawl", archived: false },
      { slug: "legacy", archived: true },
      { slug: "general" },
      { slug: "" },
    ]),
    ["withdrawl", "general"],
  );
});

test("published article filter accepts numeric and string statuses", () => {
  assert.equal(isPublishedArticle({ status: 1 }), true);
  assert.equal(isPublishedArticle({ status: "published" }), true);
  assert.equal(isPublishedArticle({ status: 0 }), false);
  assert.equal(isPublishedArticle({ status: "draft" }), false);
});

test("API article records normalize to chunk input shape", () => {
  const categoryById = new Map([["12", "Payments"]]);
  const row = normalizeArticleRecord(
    {
      id: 1778579420,
      title: "How do I withdraw?",
      content: "<p>Go to wallet.</p>",
      slug: "1778579420-withdraw",
      category_id: 12,
      status: 1,
      updated_at: "2026-01-01T00:00:00Z",
    },
    "withdrawl",
    categoryById,
  );

  assert.equal(row.faq_id, "1778579420");
  assert.equal(row.category_name, "Payments");
  assert.equal(row.portal_slug, "withdrawl");
  assert.match(row.content, /<p>/);
});

test("articles without categories still become chunks", () => {
  const { chunks, skipped } = articlesToChunks([
    {
      faq_id: "99",
      title: "How do I withdraw?",
      content: "<p>Go to wallet and request withdrawal.</p>",
      category_name: null,
      portal_slug: "withdrawl",
    },
  ]);

  assert.equal(skipped, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "chatwoot-faq-99--how-do-i-withdraw");
  assert.equal(chunks[0].source, CHATWOOT_FAQ_SOURCE);
  assert.equal(chunks[0].topic, "payments");
});

test("category mapping overrides inferred topic", () => {
  assert.deepEqual(
    topicFromCategory("Account", "Withdrawals", "How do I change my nickname?"),
    { topic: "account", feature: "account" },
  );
});

test("scoped sync SQL deletes only stale chatwoot vectors", () => {
  const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => index / 1000);
  const rows = [
    {
      id: "chatwoot-faq-1--withdraw",
      text: "# Withdraw\n\nBody",
      metadata: metadataForArticleChunk({
        id: "chatwoot-faq-1--withdraw",
        faq_id: "1",
        title: "Withdraw",
        topic: "payments",
        feature: "payments",
        source: CHATWOOT_FAQ_SOURCE,
        keywords: [],
        game_contexts: ["shop"],
        tips: [],
      }),
      embedding,
    },
  ];

  const sync = buildScopedChatwootSyncSql(rows, { pruneStale: true });
  assert.match(sync.query, /COALESCE\(target\.metadata->>'source', ''\) = 'chatwoot'/);
  assert.match(sync.query, /DELETE FROM "progolf_support"\."progolf_faq_vectors"/);
  assert.match(sync.query, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(sync.query, /playbook_rows/);
  assert.doesNotMatch(sync.query, /TRUNCATE/);
});
