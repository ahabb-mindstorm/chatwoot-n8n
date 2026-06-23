import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

const manualTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Migration',
    parameters: {},
    position: [0, 320],
    notesInFlow: true,
    notes: 'Manual one-off migration from Pinecone namespace to Chatwoot Postgres pgvector. Does not affect the live bot workflow.',
  },
  output: [{}],
});

const buildMigrationSql = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Pinecone Vectors + Build SQL',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const apiKey = $env.PINECONE_API_KEY;
if (!apiKey) throw new Error('PINECONE_API_KEY is required on the n8n container');

const indexName = String($env.PINECONE_INDEX || 'pro-golf-support').trim();
const namespace = String($env.PINECONE_NAMESPACE || 'progolf_faqs').trim();
const prefix = String($env.PINECONE_MIGRATION_PREFIX || '').trim();
const maxRecords = Number($env.PGVECTOR_MIGRATION_MAX_RECORDS || 0);
const recreate = /^(true|1|yes)$/i.test(String($env.PGVECTOR_MIGRATION_RECREATE || ''));
const pruneStale = /^(true|1|yes)$/i.test(String($env.PGVECTOR_MIGRATION_PRUNE_STALE || ''));
const schema = String($env.PGVECTOR_SCHEMA || 'progolf_support').trim();
const table = String($env.PGVECTOR_TABLE || 'progolf_faq_vectors').trim();
const embeddingModel = String($env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
const apiVersion = String($env.PINECONE_API_VERSION || '2025-04').trim();
const httpRequest = this.helpers.httpRequest.bind(this.helpers);

function identifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid ' + label + ': ' + value);
  return '"' + value.replace(/"/g, '""') + '"';
}

function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}

function queryString(params) {
  const pairs = [];
  for (const [key, value] of params) {
    if (value === undefined || value === null || value === '') continue;
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return pairs.join('&');
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

async function pineconeJson(url) {
  try {
    return await httpRequest({
      method: 'GET',
      url,
      headers: {
        'Api-Key': apiKey,
        'X-Pinecone-API-Version': apiVersion,
      },
      json: true,
    });
  } catch (error) {
    throw new Error('Pinecone request failed for ' + url + ': ' + (error.message || error));
  }
}

async function resolveHost() {
  const configured = String($env.PINECONE_INDEX_HOST || '').trim();
  if (configured) return configured.startsWith('http') ? configured : 'https://' + configured;

  const json = await pineconeJson('https://api.pinecone.io/indexes/' + encodeURIComponent(indexName));
  if (!json.host) throw new Error('Could not resolve Pinecone index host. Set PINECONE_INDEX_HOST in the n8n container.');
  return json.host.startsWith('http') ? json.host : 'https://' + json.host;
}

const host = await resolveHost();
const ids = [];
let token = '';

do {
  const url = host + '/vectors/list?' + queryString([
    ['namespace', namespace],
    ['limit', '100'],
    ['prefix', prefix],
    ['paginationToken', token],
  ]);

  const json = await pineconeJson(url);
  for (const vector of json.vectors || []) {
    if (vector.id) ids.push(vector.id);
    if (maxRecords && ids.length >= maxRecords) break;
  }
  token = json.pagination?.next || json.pagination_token || '';
} while (token && (!maxRecords || ids.length < maxRecords));

if (ids.length === 0) {
  throw new Error('No Pinecone vector IDs found. Check PINECONE_INDEX, PINECONE_NAMESPACE, and optional PINECONE_MIGRATION_PREFIX.');
}

const rows = [];
const skipped = [];
for (let i = 0; i < ids.length; i += 100) {
  const batchIds = ids.slice(i, i + 100);
  const url = host + '/vectors/fetch?' + queryString([
    ['namespace', namespace],
    ...batchIds.map((id) => ['ids', id]),
  ]);

  const json = await pineconeJson(url);
  for (const vector of Object.values(json.vectors || {})) {
    const metadata = vector.metadata || {};
    const text = String(metadata.text || metadata.pageContent || metadata.content || metadata.body || metadata.title || '').trim();
    if (!text) {
      skipped.push({ id: vector.id, reason: 'missing_text_metadata' });
      continue;
    }

    const faqMatch = String(vector.id || '').match(/helpshift-faq-(\\d+)/);
    const outMetadata = {
      ...metadata,
      doc_id: metadata.doc_id || vector.id,
      faq_id: metadata.faq_id || (faqMatch ? faqMatch[1] : ''),
      source: metadata.source || 'pinecone',
      migrated_from: 'pinecone',
      pinecone_index: indexName,
      pinecone_namespace: namespace,
      embedding_model: metadata.embedding_model || embeddingModel,
    };

    rows.push({
      id: vector.id,
      text,
      metadata: outMetadata,
      embedding: vector.values,
    });
  }
}

if (rows.length === 0) {
  throw new Error('Fetched Pinecone vectors, but none had text/content metadata to insert into pgvector.');
}

const tableName = identifier(schema, 'schema') + '.' + identifier(table, 'table');
const valueTuples = rows.map((row) => {
  return '(' + [
    sqlString(row.id),
    sqlString(row.text),
    sqlString(JSON.stringify(row.metadata)) + '::jsonb',
    sqlString(vectorLiteral(row.embedding)) + '::vector',
  ].join(', ') + ')';
});
const idTuples = rows.map((row) => '(' + sqlString(row.id) + ')');

const statements = [
  'BEGIN',
  recreate ? 'DELETE FROM ' + tableName : '',
  'INSERT INTO ' + tableName + ' (id, text, metadata, embedding) VALUES\\n' + valueTuples.join(',\\n') + '\\nON CONFLICT (id) DO UPDATE SET\\n  text = EXCLUDED.text,\\n  metadata = EXCLUDED.metadata,\\n  embedding = EXCLUDED.embedding,\\n  updated_at = NOW()',
  pruneStale ? 'WITH incoming(id) AS (VALUES\\n' + idTuples.join(',\\n') + '\\n) DELETE FROM ' + tableName + ' target WHERE NOT EXISTS (SELECT 1 FROM incoming WHERE incoming.id = target.id)' : '',
  'COMMIT',
  'SELECT COUNT(*)::int AS total_rows FROM ' + tableName,
].filter(Boolean);

return [{
  json: {
    query: statements.join(';\\n') + ';',
    source_index: indexName,
    source_namespace: namespace,
    pinecone_host: host,
    listed_ids: ids.length,
    fetched_rows: rows.length,
    skipped_count: skipped.length,
    skipped_sample: skipped.slice(0, 5),
    recreate,
    prune_stale: pruneStale,
    target_table: schema + '.' + table,
  },
}];`,
    },
    position: [280, 320],
    notesInFlow: true,
    notes: 'Uses Pinecone REST list/fetch endpoints, then prepares a pgvector upsert SQL statement. Defaults namespace to progolf_faqs.',
  },
  output: [{ json: { query: 'SQL', fetched_rows: 1 } }],
});

const upsertPgvector = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert Into Chatwoot PGVector',
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
    position: [620, 320],
    notesInFlow: true,
    notes: 'Writes to progolf_support.progolf_faq_vectors using the Chatwoot PGVector Postgres credential.',
  },
  output: [{ json: { total_rows: 0 } }],
});

const migrationSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Migration Summary',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const migration = $('Fetch Pinecone Vectors + Build SQL').first().json;
const dbResult = $input.first().json;

return [{
  json: {
    status: 'complete',
    source_index: migration.source_index,
    source_namespace: migration.source_namespace,
    listed_ids: migration.listed_ids,
    upserted_rows: migration.fetched_rows,
    skipped_count: migration.skipped_count,
    skipped_sample: migration.skipped_sample,
    target_table: migration.target_table,
    recreate: migration.recreate,
    prune_stale: migration.prune_stale,
    total_rows_after: dbResult.total_rows ?? dbResult.count ?? null,
  },
}];`,
    },
    position: [920, 320],
  },
  output: [{ json: { status: 'complete' } }],
});

export default workflow('progolf-pinecone-to-pgvector-migration', 'ProGolf Pinecone to PGVector Migration')
  .add(manualTrigger)
  .to(buildMigrationSql)
  .to(upsertPgvector)
  .to(migrationSummary);
