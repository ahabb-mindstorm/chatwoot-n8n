import { workflow, node, trigger, ifElse, newCredential, sticky } from '@n8n/workflow-sdk';

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
      jsCode: "const baseUrl = String($env.CHATWOOT_BASE_URL || '').replace(/\\/$/, '');\nconst token = String($env.CHATWOOT_API_ACCESS_TOKEN || '').trim();\nconst accountId = String($env.CHATWOOT_ACCOUNT_ID || '').trim();\nconst portalFilter = String($env.CHATWOOT_PORTAL_SLUG || '').trim();\nconst httpRequest = this.helpers.httpRequest.bind(this.helpers);\n\nif (!baseUrl || !token) {\n  throw new Error('CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN are required on the n8n container');\n}\nif (!accountId) {\n  throw new Error('CHATWOOT_ACCOUNT_ID is required on the n8n container');\n}\n\nasync function chatwootApi(path) {\n  return httpRequest({\n    method: 'GET',\n    url: baseUrl + path,\n    headers: { api_access_token: token },\n    json: true,\n  });\n}\n\nfunction isPublished(status) {\n  return status === 1 || status === 'published' || status === 'Published';\n}\n\nasync function listPortalSlugs() {\n  const payload = await chatwootApi('/api/v1/accounts/' + accountId + '/portals');\n  const portals = payload.payload || payload || [];\n  return portals\n    .filter((portal) => portal.archived !== true)\n    .map((portal) => String(portal.slug || '').trim())\n    .filter(Boolean);\n}\n\nasync function listArticlesForPortal(portalSlug) {\n  const categoriesPayload = await chatwootApi(\n    '/api/v1/accounts/' + accountId + '/portals/' + portalSlug + '/categories',\n  );\n  const categories = categoriesPayload.payload || categoriesPayload || [];\n  const categoryById = new Map(\n    categories.map((cat) => [String(cat.id), String(cat.name || '').trim()]),\n  );\n\n  const rows = [];\n  for (let page = 1; page <= 100; page++) {\n    const payload = await chatwootApi(\n      '/api/v1/accounts/' + accountId + '/portals/' + portalSlug + '/articles?page=' + page,\n    );\n    const batch = payload.payload || [];\n    for (const article of batch) {\n      if (!isPublished(article.status)) continue;\n      rows.push({\n        faq_id: String(article.id),\n        title: String(article.title || '').trim(),\n        content: String(article.content || ''),\n        slug: String(article.slug || '').trim(),\n        category_name: categoryById.get(String(article.category_id)) || '',\n        portal_slug: portalSlug,\n        updated_at: article.updated_at || null,\n      });\n    }\n    if (batch.length < 25) break;\n  }\n  return rows;\n}\n\nconst portalSlugs = portalFilter ? [portalFilter] : await listPortalSlugs();\nif (portalSlugs.length === 0) {\n  throw new Error('No Help Center portals found for account ' + accountId);\n}\n\nconst articles = [];\nfor (const portalSlug of portalSlugs) {\n  articles.push(...(await listArticlesForPortal(portalSlug)));\n}\narticles.sort((a, b) => Number(a.faq_id) - Number(b.faq_id));\n\nreturn articles.map((row) => ({ json: row }));\n",
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
      jsCode: "const articles = $input.all().map((item) => item.json);\nconst accountId = Number($env.CHATWOOT_ACCOUNT_ID || 0);\nconst portalSlug = String($env.CHATWOOT_PORTAL_SLUG || '').trim();\nconst dryRun = /^(true|1|yes)$/i.test(String($env.PGVECTOR_SYNC_DRY_RUN || ''));\nconst pruneStale = !/^(false|0|no)$/i.test(String($env.PGVECTOR_SYNC_PRUNE_STALE || 'true'));\nconst schema = String($env.PGVECTOR_SCHEMA || 'progolf_support').trim();\nconst table = String($env.PGVECTOR_TABLE || 'progolf_faq_vectors').trim();\nconst embeddingModel = String($env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small').trim();\nconst batchSize = Math.max(1, Number($env.OPENAI_EMBEDDING_BATCH_SIZE || 32));\nconst apiKey = String($env.OPENAI_API_KEY || '').trim();\nconst httpRequest = this.helpers.httpRequest.bind(this.helpers);\nconst source = 'chatwoot';\n\nif (!accountId) throw new Error('CHATWOOT_ACCOUNT_ID is required on the n8n container');\n\nconst CATEGORY_TOPIC = {\n  Account: { topic: 'account', feature: 'account' },\n  Payments: { topic: 'payments', feature: 'payments' },\n  Gameplay: { topic: 'gameplay', feature: 'gameplay' },\n  'Game Modes': { topic: 'game_modes', feature: 'game_modes' },\n  Equipment: { topic: 'equipment', feature: 'equipment' },\n  LootBags: { topic: 'loot_bags', feature: 'loot_bags' },\n  'Golf Pass': { topic: 'season_pass', feature: 'season_pass' },\n  Shop: { topic: 'shop', feature: 'shop' },\n  Personalization: { topic: 'personalization', feature: 'personalization' },\n  General: { topic: 'general', feature: 'general' },\n};\nconst MAX_CHUNK_CHARS = 2800;\n\nfunction identifier(value, label) {\n  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid ' + label + ': ' + value);\n  return '\"' + value.replace(/\"/g, '\"\"') + '\"';\n}\nfunction sqlString(value) {\n  return \"'\" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, \"''\") + \"'\";\n}\nfunction slugify(text) {\n  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);\n}\nfunction htmlToText(html) {\n  return String(html || '')\n    .replace(/<br\\s*\\/?>/gi, '\\n')\n    .replace(/<\\/p>/gi, '\\n')\n    .replace(/<\\/li>/gi, '\\n- ')\n    .replace(/<[^>]+>/g, '')\n    .replace(/&nbsp;/gi, ' ')\n    .replace(/&amp;/gi, '&')\n    .replace(/&lt;/gi, '<')\n    .replace(/&gt;/gi, '>')\n    .replace(/&#39;/gi, \"'\")\n    .replace(/&quot;/gi, '\"')\n    .replace(/\\u00a0/g, ' ')\n    .replace(/[ \\t]+\\n/g, '\\n')\n    .replace(/\\n{3,}/g, '\\n\\n')\n    .trim();\n}\nfunction inferTopic(title, body) {\n  const blob = (title + ' ' + body).toLowerCase();\n  if (/withdraw|deposit|paypal|payment|wallet|billing|refund/.test(blob)) return { topic: 'payments', feature: 'payments' };\n  if (/tournament|leaderboard|entry fee|prize pool|matchmaking|forfeit/.test(blob)) return { topic: 'game_modes', feature: 'game_modes' };\n  if (/register|account|login|otp|phone/.test(blob)) return { topic: 'account', feature: 'account' };\n  return { topic: 'general', feature: 'general' };\n}\nfunction topicFromCategory(categoryName, title, body) {\n  const normalized = String(categoryName || '').trim();\n  if (normalized && CATEGORY_TOPIC[normalized]) return CATEGORY_TOPIC[normalized];\n  return inferTopic(title, body);\n}\nfunction inferGameContexts(title, body) {\n  const t = (title + ' ' + body).toLowerCase();\n  const contexts = new Set();\n  if (/tournament|championship|leaderboard|entry fee|prize pool|forfeit/.test(t)) contexts.add('tournament');\n  if (/withdraw|deposit|wallet|purchase|shop/.test(t)) contexts.add('shop');\n  if (contexts.size === 0) contexts.add('main_screen');\n  return [...contexts];\n}\nfunction extractTips(text) {\n  const tips = [];\n  for (const line of text.split('\\n')) {\n    const trimmed = line.trim();\n    if (!trimmed) continue;\n    if (/^[-*•]\\s+/.test(trimmed) && trimmed.length < 200) tips.push(trimmed.replace(/^[-*•]\\s+/, ''));\n  }\n  if (tips.length === 0) {\n    tips.push(...text.split(/(?<=[.!?])\\s+/).filter((s) => s.length > 20 && s.length < 180).slice(0, 3));\n  }\n  return [...new Set(tips)].slice(0, 5);\n}\nfunction extractKeywords(title, body) {\n  const words = (title + ' ' + body).toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').split(/\\s+/).filter((w) => w.length > 3);\n  const stop = new Set(['what', 'when', 'where', 'which', 'that', 'this', 'with', 'from', 'have', 'your', 'will', 'does', 'about', 'game', 'cash', 'real', 'golf']);\n  const freq = new Map();\n  for (const w of words) {\n    if (stop.has(w)) continue;\n    freq.set(w, (freq.get(w) || 0) + 1);\n  }\n  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);\n}\nfunction splitLongBody(title, body) {\n  if (body.length <= MAX_CHUNK_CHARS) return [{ part: 'full', text: '# ' + title + '\\n\\n' + body }];\n  const parts = [];\n  const paragraphs = body.split(/\\n\\n+/);\n  let buffer = '# ' + title + '\\n\\n';\n  let partIndex = 0;\n  for (const para of paragraphs) {\n    if (buffer.length + para.length > MAX_CHUNK_CHARS && buffer.length > title.length + 4) {\n      parts.push({ part: 'p' + partIndex++, text: buffer.trim() });\n      buffer = '# ' + title + ' (continued)\\n\\n' + para + '\\n\\n';\n    } else {\n      buffer += para + '\\n\\n';\n    }\n  }\n  if (buffer.trim()) parts.push({ part: 'p' + partIndex, text: buffer.trim() });\n  return parts;\n}\nfunction metadataForChunk(chunk) {\n  return {\n    doc_id: chunk.id,\n    faq_id: chunk.faq_id || '',\n    title: chunk.title || '',\n    topic: chunk.topic || '',\n    feature: chunk.feature || '',\n    source,\n    keywords: chunk.keywords || [],\n    game_contexts: chunk.game_contexts || [],\n    tips: chunk.tips || [],\n    embedding_model: embeddingModel,\n    portal_slug: chunk.portal_slug || '',\n    category_name: chunk.category_name || '',\n    slug: chunk.slug || '',\n  };\n}\nfunction vectorLiteral(values) {\n  if (!Array.isArray(values) || values.length !== 1536) {\n    throw new Error('Expected 1536-dimension vector, got ' + (Array.isArray(values) ? values.length : typeof values));\n  }\n  return '[' + values.map((value, index) => {\n    const n = Number(value);\n    if (!Number.isFinite(n)) throw new Error('Invalid embedding value at index ' + index);\n    return n;\n  }).join(',') + ']';\n}\nasync function embedTexts(texts) {\n  if (!apiKey) throw new Error('OPENAI_API_KEY is required on the n8n container');\n  const vectors = [];\n  for (let i = 0; i < texts.length; i += batchSize) {\n    const batch = texts.slice(i, i + batchSize);\n    const response = await httpRequest({\n      method: 'POST',\n      url: 'https://api.openai.com/v1/embeddings',\n      headers: {\n        Authorization: 'Bearer ' + apiKey,\n        'Content-Type': 'application/json',\n      },\n      body: { model: embeddingModel, input: batch },\n      json: true,\n    });\n    const sorted = [...(response.data || [])].sort((a, b) => a.index - b.index);\n    vectors.push(...sorted.map((row) => row.embedding));\n  }\n  return vectors;\n}\n\nconst chunks = [];\nlet skipped = 0;\nfor (const row of articles) {\n  const faqId = String(row.faq_id || row.id || '').trim();\n  const title = String(row.title || '').trim();\n  const plainBody = htmlToText(row.content);\n  if (!faqId || !title || !plainBody) {\n    skipped++;\n    continue;\n  }\n  const slug = slugify(title) || 'faq';\n  const topicInfo = topicFromCategory(row.category_name, title, plainBody);\n  const parts = splitLongBody(title, plainBody);\n  for (const part of parts) {\n    const id = parts.length === 1\n      ? 'chatwoot-faq-' + faqId + '--' + slug\n      : 'chatwoot-faq-' + faqId + '--' + slug + '--' + part.part;\n    chunks.push({\n      id,\n      title,\n      topic: topicInfo.topic,\n      feature: topicInfo.feature,\n      text: part.text,\n      faq_id: faqId,\n      slug,\n      portal_slug: String(row.portal_slug || '').trim(),\n      category_name: String(row.category_name || '').trim(),\n      keywords: extractKeywords(title, plainBody),\n      game_contexts: inferGameContexts(title, plainBody),\n      tips: extractTips(plainBody),\n    });\n  }\n}\n\nconst base = {\n  account_id: accountId,\n  portal_slug: portalSlug || null,\n  articles_fetched: articles.length,\n  chunks: chunks.length,\n  skipped_articles: skipped,\n  sample_ids: chunks.slice(0, 3).map((chunk) => chunk.id),\n  target_table: schema + '.' + table,\n  embedding_model: embeddingModel,\n  prune_stale: pruneStale,\n  dry_run: dryRun,\n};\n\nif (chunks.length === 0) {\n  return [{ json: { ...base, status: 'no_articles', query: null } }];\n}\n\nif (dryRun) {\n  return [{ json: { ...base, status: 'dry_run', query: null } }];\n}\n\nconst embeddings = await embedTexts(chunks.map((chunk) => chunk.text));\nif (embeddings.length !== chunks.length) {\n  throw new Error('Embedding count mismatch: ' + embeddings.length + ' vs ' + chunks.length);\n}\n\nconst rows = chunks.map((chunk, index) => ({\n  id: chunk.id,\n  text: chunk.text,\n  metadata: metadataForChunk(chunk),\n  embedding: embeddings[index],\n}));\n\nconst tableName = identifier(schema, 'schema') + '.' + identifier(table, 'table');\nconst valueTuples = rows.map((row) => '(' + [\n  sqlString(row.id),\n  sqlString(row.text),\n  sqlString(JSON.stringify(row.metadata)) + '::jsonb',\n  sqlString(vectorLiteral(row.embedding)) + '::vector',\n].join(', ') + ')');\nconst idTuples = rows.map((row) => '(' + sqlString(row.id) + ')');\n\nconst statements = [\n  'BEGIN',\n  pruneStale ? 'DELETE FROM ' + tableName + ' target\\nWHERE COALESCE(target.metadata->>\\'source\\', \\'\\') = ' + sqlString(source) + '\\n  AND NOT EXISTS (\\n    SELECT 1\\n    FROM (VALUES ' + idTuples.join(',\\n') + ') AS incoming(id)\\n    WHERE incoming.id = target.id\\n  )' : '',\n  'INSERT INTO ' + tableName + ' (id, text, metadata, embedding) VALUES\\n' + valueTuples.join(',\\n') + '\\nON CONFLICT (id) DO UPDATE SET\\n  text = EXCLUDED.text,\\n  metadata = EXCLUDED.metadata,\\n  embedding = EXCLUDED.embedding,\\n  updated_at = NOW()',\n  'COMMIT',\n  'SELECT\\n  COUNT(*)::int AS total_rows,\\n  COUNT(*) FILTER (WHERE metadata->>\\'source\\' = ' + sqlString(source) + ')::int AS chatwoot_rows,\\n  COUNT(*) FILTER (WHERE COALESCE(metadata->>\\'doc_type\\', \\'faq\\') = \\'support_playbook\\')::int AS playbook_rows\\nFROM ' + tableName,\n].filter(Boolean);\n\nreturn [{\n  json: {\n    ...base,\n    status: 'ready',\n    upserted_rows: rows.length,\n    query: statements.join(';\\n') + ';',\n  },\n}];",
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
      jsCode: "const sync = $('Build Chunks + Embeddings + SQL').first().json;\nconst dbResult = $input.first()?.json || {};\n\nreturn [{\n  json: {\n    status: sync.status === 'ready' ? 'complete' : sync.status,\n    account_id: sync.account_id,\n    portal_slug: sync.portal_slug,\n    articles_fetched: sync.articles_fetched,\n    chunks: sync.chunks,\n    skipped_articles: sync.skipped_articles,\n    upserted_rows: sync.upserted_rows || 0,\n    sample_ids: sync.sample_ids,\n    target_table: sync.target_table,\n    embedding_model: sync.embedding_model,\n    prune_stale: sync.prune_stale,\n    dry_run: sync.dry_run,\n    total_rows_after: dbResult.total_rows ?? null,\n    chatwoot_rows_after: dbResult.chatwoot_rows ?? null,\n    playbook_rows_after: dbResult.playbook_rows ?? null,\n  },\n}];",
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
      jsCode: "const sync = $('Build Chunks + Embeddings + SQL').first().json;\nreturn [{ json: { ...sync, status: sync.status || 'skipped' } }];",
    },
    position: [1180, 520],
  },
  output: [{ json: { status: 'dry_run' } }],
});

const workflowNote = sticky(
  '## Chatwoot FAQ → PGVector Sync\nFetches published Help Center articles via Chatwoot API, embeds with OpenAI, deletes stale Chatwoot FAQ vectors, and upserts into progolf_support.progolf_faq_vectors.\n\nEnv knobs:\n- CHATWOOT_BASE_URL\n- CHATWOOT_API_ACCESS_TOKEN\n- CHATWOOT_ACCOUNT_ID\n- CHATWOOT_PORTAL_SLUG (optional)\n- PGVECTOR_SYNC_DRY_RUN=true\n- PGVECTOR_SYNC_PRUNE_STALE=false\n- PGVECTOR_SCHEMA / PGVECTOR_TABLE\n- OPENAI_API_KEY / OPENAI_EMBEDDING_MODEL',
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
