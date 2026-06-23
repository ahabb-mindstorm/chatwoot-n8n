import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fetchArticlesJsCode = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "n8n-templates/fetch-chatwoot-articles.js"),
  "utf8",
);
const buildSyncJsCode = String.raw`const articles = $input.all().map((item) => item.json);
const accountId = Number($env.CHATWOOT_ACCOUNT_ID || 0);
const portalSlug = String($env.CHATWOOT_PORTAL_SLUG || '').trim();
const dryRun = /^(true|1|yes)$/i.test(String($env.PGVECTOR_SYNC_DRY_RUN || ''));
const pruneStale = !/^(false|0|no)$/i.test(String($env.PGVECTOR_SYNC_PRUNE_STALE || 'true'));
const schema = String($env.PGVECTOR_SCHEMA || 'progolf_support').trim();
const table = String($env.PGVECTOR_TABLE || 'progolf_faq_vectors').trim();
const embeddingModel = String($env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
const batchSize = Math.max(1, Number($env.OPENAI_EMBEDDING_BATCH_SIZE || 32));
const apiKey = String($env.OPENAI_API_KEY || '').trim();
const httpRequest = this.helpers.httpRequest.bind(this.helpers);
const source = 'chatwoot';

if (!accountId) throw new Error('CHATWOOT_ACCOUNT_ID is required on the n8n container');

const CATEGORY_TOPIC = {
  Account: { topic: 'account', feature: 'account' },
  Payments: { topic: 'payments', feature: 'payments' },
  Gameplay: { topic: 'gameplay', feature: 'gameplay' },
  'Game Modes': { topic: 'game_modes', feature: 'game_modes' },
  Equipment: { topic: 'equipment', feature: 'equipment' },
  LootBags: { topic: 'loot_bags', feature: 'loot_bags' },
  'Golf Pass': { topic: 'season_pass', feature: 'season_pass' },
  Shop: { topic: 'shop', feature: 'shop' },
  Personalization: { topic: 'personalization', feature: 'personalization' },
  General: { topic: 'general', feature: 'general' },
};
const MAX_CHUNK_CHARS = 2800;

function identifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid ' + label + ': ' + value);
  return '"' + value.replace(/"/g, '""') + '"';
}
function sqlString(value) {
  return "'" + String(value ?? '').replace(/\u0000/g, '').replace(/'/g, "''") + "'";
}
function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function inferTopic(title, body) {
  const blob = (title + ' ' + body).toLowerCase();
  if (/withdraw|deposit|paypal|payment|wallet|billing|refund/.test(blob)) return { topic: 'payments', feature: 'payments' };
  if (/tournament|leaderboard|entry fee|prize pool|matchmaking|forfeit/.test(blob)) return { topic: 'game_modes', feature: 'game_modes' };
  if (/register|account|login|otp|phone/.test(blob)) return { topic: 'account', feature: 'account' };
  return { topic: 'general', feature: 'general' };
}
function topicFromCategory(categoryName, title, body) {
  const normalized = String(categoryName || '').trim();
  if (normalized && CATEGORY_TOPIC[normalized]) return CATEGORY_TOPIC[normalized];
  return inferTopic(title, body);
}
function inferGameContexts(title, body) {
  const t = (title + ' ' + body).toLowerCase();
  const contexts = new Set();
  if (/tournament|championship|leaderboard|entry fee|prize pool|forfeit/.test(t)) contexts.add('tournament');
  if (/withdraw|deposit|wallet|purchase|shop/.test(t)) contexts.add('shop');
  if (contexts.size === 0) contexts.add('main_screen');
  return [...contexts];
}
function extractTips(text) {
  const tips = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-*•]\s+/.test(trimmed) && trimmed.length < 200) tips.push(trimmed.replace(/^[-*•]\s+/, ''));
  }
  if (tips.length === 0) {
    tips.push(...text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20 && s.length < 180).slice(0, 3));
  }
  return [...new Set(tips)].slice(0, 5);
}
function extractKeywords(title, body) {
  const words = (title + ' ' + body).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const stop = new Set(['what', 'when', 'where', 'which', 'that', 'this', 'with', 'from', 'have', 'your', 'will', 'does', 'about', 'game', 'cash', 'real', 'golf']);
  const freq = new Map();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
}
function splitLongBody(title, body) {
  if (body.length <= MAX_CHUNK_CHARS) return [{ part: 'full', text: '# ' + title + '\n\n' + body }];
  const parts = [];
  const paragraphs = body.split(/\n\n+/);
  let buffer = '# ' + title + '\n\n';
  let partIndex = 0;
  for (const para of paragraphs) {
    if (buffer.length + para.length > MAX_CHUNK_CHARS && buffer.length > title.length + 4) {
      parts.push({ part: 'p' + partIndex++, text: buffer.trim() });
      buffer = '# ' + title + ' (continued)\n\n' + para + '\n\n';
    } else {
      buffer += para + '\n\n';
    }
  }
  if (buffer.trim()) parts.push({ part: 'p' + partIndex, text: buffer.trim() });
  return parts;
}
function metadataForChunk(chunk) {
  return {
    doc_id: chunk.id,
    faq_id: chunk.faq_id || '',
    title: chunk.title || '',
    topic: chunk.topic || '',
    feature: chunk.feature || '',
    source,
    keywords: chunk.keywords || [],
    game_contexts: chunk.game_contexts || [],
    tips: chunk.tips || [],
    embedding_model: embeddingModel,
    portal_slug: chunk.portal_slug || '',
    category_name: chunk.category_name || '',
    slug: chunk.slug || '',
  };
}
function vectorLiteral(values) {
  if (!Array.isArray(values) || values.length !== 1536) {
    throw new Error('Expected 1536-dimension vector, got ' + (Array.isArray(values) ? values.length : typeof values));
  }
  return '[' + values.map((value, index) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('Invalid embedding value at index ' + index);
    return n;
  }).join(',') + ']';
}
async function embedTexts(texts) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required on the n8n container');
  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await httpRequest({
      method: 'POST',
      url: 'https://api.openai.com/v1/embeddings',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: { model: embeddingModel, input: batch },
      json: true,
    });
    const sorted = [...(response.data || [])].sort((a, b) => a.index - b.index);
    vectors.push(...sorted.map((row) => row.embedding));
  }
  return vectors;
}

const chunks = [];
let skipped = 0;
for (const row of articles) {
  const faqId = String(row.faq_id || row.id || '').trim();
  const title = String(row.title || '').trim();
  const plainBody = htmlToText(row.content);
  if (!faqId || !title || !plainBody) {
    skipped++;
    continue;
  }
  const slug = slugify(title) || 'faq';
  const topicInfo = topicFromCategory(row.category_name, title, plainBody);
  const parts = splitLongBody(title, plainBody);
  for (const part of parts) {
    const id = parts.length === 1
      ? 'chatwoot-faq-' + faqId + '--' + slug
      : 'chatwoot-faq-' + faqId + '--' + slug + '--' + part.part;
    chunks.push({
      id,
      title,
      topic: topicInfo.topic,
      feature: topicInfo.feature,
      text: part.text,
      faq_id: faqId,
      slug,
      portal_slug: String(row.portal_slug || '').trim(),
      category_name: String(row.category_name || '').trim(),
      keywords: extractKeywords(title, plainBody),
      game_contexts: inferGameContexts(title, plainBody),
      tips: extractTips(plainBody),
    });
  }
}

const base = {
  account_id: accountId,
  portal_slug: portalSlug || null,
  articles_fetched: articles.length,
  chunks: chunks.length,
  skipped_articles: skipped,
  sample_ids: chunks.slice(0, 3).map((chunk) => chunk.id),
  target_table: schema + '.' + table,
  embedding_model: embeddingModel,
  prune_stale: pruneStale,
  dry_run: dryRun,
};

if (chunks.length === 0) {
  return [{ json: { ...base, status: 'no_articles', query: null } }];
}

if (dryRun) {
  return [{ json: { ...base, status: 'dry_run', query: null } }];
}

const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
if (embeddings.length !== chunks.length) {
  throw new Error('Embedding count mismatch: ' + embeddings.length + ' vs ' + chunks.length);
}

const rows = chunks.map((chunk, index) => ({
  id: chunk.id,
  text: chunk.text,
  metadata: metadataForChunk(chunk),
  embedding: embeddings[index],
}));

const tableName = identifier(schema, 'schema') + '.' + identifier(table, 'table');
const valueTuples = rows.map((row) => '(' + [
  sqlString(row.id),
  sqlString(row.text),
  sqlString(JSON.stringify(row.metadata)) + '::jsonb',
  sqlString(vectorLiteral(row.embedding)) + '::vector',
].join(', ') + ')');
const idTuples = rows.map((row) => '(' + sqlString(row.id) + ')');

const statements = [
  'BEGIN',
  pruneStale ? 'DELETE FROM ' + tableName + ' target\nWHERE COALESCE(target.metadata->>\'source\', \'\') = ' + sqlString(source) + '\n  AND NOT EXISTS (\n    SELECT 1\n    FROM (VALUES ' + idTuples.join(',\n') + ') AS incoming(id)\n    WHERE incoming.id = target.id\n  )' : '',
  'INSERT INTO ' + tableName + ' (id, text, metadata, embedding) VALUES\n' + valueTuples.join(',\n') + '\nON CONFLICT (id) DO UPDATE SET\n  text = EXCLUDED.text,\n  metadata = EXCLUDED.metadata,\n  embedding = EXCLUDED.embedding,\n  updated_at = NOW()',
  'COMMIT',
  'SELECT\n  COUNT(*)::int AS total_rows,\n  COUNT(*) FILTER (WHERE metadata->>\'source\' = ' + sqlString(source) + ')::int AS chatwoot_rows,\n  COUNT(*) FILTER (WHERE COALESCE(metadata->>\'doc_type\', \'faq\') = \'support_playbook\')::int AS playbook_rows\nFROM ' + tableName,
].filter(Boolean);

return [{
  json: {
    ...base,
    status: 'ready',
    upserted_rows: rows.length,
    query: statements.join(';\n') + ';',
  },
}];`;

const summaryJsCode = String.raw`const sync = $('Build Chunks + Embeddings + SQL').first().json;
const dbResult = $input.first()?.json || {};

return [{
  json: {
    status: sync.status === 'ready' ? 'complete' : sync.status,
    account_id: sync.account_id,
    portal_slug: sync.portal_slug,
    articles_fetched: sync.articles_fetched,
    chunks: sync.chunks,
    skipped_articles: sync.skipped_articles,
    upserted_rows: sync.upserted_rows || 0,
    sample_ids: sync.sample_ids,
    target_table: sync.target_table,
    embedding_model: sync.embedding_model,
    prune_stale: sync.prune_stale,
    dry_run: sync.dry_run,
    total_rows_after: dbResult.total_rows ?? null,
    chatwoot_rows_after: dbResult.chatwoot_rows ?? null,
    playbook_rows_after: dbResult.playbook_rows ?? null,
  },
}];`;

const drySummaryJsCode = String.raw`const sync = $('Build Chunks + Embeddings + SQL').first().json;
return [{ json: { ...sync, status: sync.status || 'skipped' } }];`;

const sdk = `import { workflow, node, trigger, ifElse, newCredential, sticky } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-chatwoot-faq-to-pgvector-sync';
const WORKFLOW_NAME = 'ProGolf Chatwoot FAQ to PGVector Sync';

const manualTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Sync',
    parameters: {},
    position: [0, 280],
    notesInFlow: true,
    notes: 'Manual sync of published Chatwoot Help Center articles into progolf_support.progolf_faq_vectors.',
  },
  output: [{}],
});

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily Sync',
    parameters: {
      rule: {
        interval: [
          {
            field: 'days',
            daysInterval: 1,
            triggerAtHour: 4,
            triggerAtMinute: 0,
          },
        ],
      },
    },
    position: [0, 520],
    notesInFlow: true,
    notes: 'Runs daily at 04:00 server time. Adjust in n8n if needed.',
  },
  output: [{}],
});

const fetchPublishedArticles = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Published Articles',
    executeOnce: true,
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${JSON.stringify(fetchArticlesJsCode)},
    },
    position: [320, 400],
    notesInFlow: true,
    notes: 'Lists published Help Center articles via Chatwoot API (CHATWOOT_BASE_URL + CHATWOOT_API_ACCESS_TOKEN). Optional CHATWOOT_PORTAL_SLUG; empty = all portals.',
  },
  output: [{ faq_id: '1778579420', title: 'How do I request a withdrawal?', content: '<p>Example</p>', category_name: 'Payments', portal_slug: 'withdrawl' }],
});

const buildSyncPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Chunks + Embeddings + SQL',
    executeOnce: true,
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${JSON.stringify(buildSyncJsCode)},
    },
    position: [620, 400],
    notesInFlow: true,
    notes: 'Transforms articles, embeds with OpenAI, and builds a scoped pgvector upsert transaction. Set PGVECTOR_SYNC_DRY_RUN=true to preview only.',
  },
  output: [{ json: { status: 'ready', query: 'BEGIN; COMMIT;', upserted_rows: 1 } }],
});

const shouldWriteVectors = ifElse({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Write Vectors?',
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
        conditions: [
          {
            id: 'has-query',
            leftValue: '={{ Boolean($json.query) }}',
            rightValue: true,
            operator: {
              type: 'boolean',
              operation: 'equals',
            },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [900, 400],
  },
  output: [{}],
});

const upsertPgvector = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert Chatwoot FAQ Vectors',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.query }}',
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('Chatwoot PGVector Postgres'),
    },
    position: [1180, 320],
    notesInFlow: true,
    notes: 'Scoped delete for metadata.source=chatwoot, then upsert current article vectors. Playbooks are preserved.',
  },
  output: [{ total_rows: 100, chatwoot_rows: 94, playbook_rows: 6 }],
});

const syncSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Summary',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${JSON.stringify(summaryJsCode)},
    },
    position: [1460, 320],
  },
  output: [{ json: { status: 'complete' } }],
});

const dryRunSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Dry Run / Skip Summary',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${JSON.stringify(drySummaryJsCode)},
    },
    position: [1180, 520],
  },
  output: [{ json: { status: 'dry_run' } }],
});

const workflowNote = sticky(
  '## Chatwoot FAQ → PGVector Sync\\nFetches published Help Center articles via Chatwoot API, embeds with OpenAI, deletes stale Chatwoot FAQ vectors, and upserts into progolf_support.progolf_faq_vectors.\\n\\nEnv knobs:\\n- CHATWOOT_BASE_URL\\n- CHATWOOT_API_ACCESS_TOKEN\\n- CHATWOOT_ACCOUNT_ID\\n- CHATWOOT_PORTAL_SLUG (optional)\\n- PGVECTOR_SYNC_DRY_RUN=true\\n- PGVECTOR_SYNC_PRUNE_STALE=false\\n- PGVECTOR_SCHEMA / PGVECTOR_TABLE\\n- OPENAI_API_KEY / OPENAI_EMBEDDING_MODEL',
  [manualTrigger, syncSummary],
  { height: 260, width: 760, color: 4 },
);

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(workflowNote)
  .add(manualTrigger)
  .to(fetchPublishedArticles)
  .add(scheduleTrigger)
  .to(fetchPublishedArticles)
  .add(fetchPublishedArticles)
  .to(buildSyncPayload)
  .to(shouldWriteVectors
    .onTrue(upsertPgvector.to(syncSummary))
    .onFalse(dryRunSummary));
`;

const outPath = join(root, "workflows/progolf-chatwoot-faq-to-pgvector-sync.sdk.js");
writeFileSync(outPath, sdk);
console.log(`Wrote ${outPath}`);
