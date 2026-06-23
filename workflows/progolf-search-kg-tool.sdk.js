import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-search-kg-tool';
const WORKFLOW_NAME = 'ProGolf Search KG Tool';

const kgLookupSql = `WITH input_terms AS (
  SELECT DISTINCT trim(value)::text AS term
  FROM jsonb_array_elements_text($1::jsonb)
  WHERE trim(value) <> ''
),
tables AS (
  SELECT
    to_regclass('progolf_support.progolf_kg_entities') IS NOT NULL AS has_entities,
    to_regclass('progolf_support.progolf_kg_relationships') IS NOT NULL AS has_relationships
),
matched AS (
  SELECT DISTINCT e.*
  FROM progolf_support.progolf_kg_entities e
  JOIN input_terms s
    ON e.normalized_name = s.term
    OR s.term = ANY (
      SELECT lower(regexp_replace(alias, '[^a-zA-Z0-9$]+', ' ', 'g'))
      FROM unnest(e.aliases) alias
    )
  JOIN tables t ON t.has_entities AND t.has_relationships
  WHERE e.type IN ('tournament','level','region','quest','item','mode','currency','character','other')
),
first_hop AS (
  SELECT DISTINCT r.*
  FROM progolf_support.progolf_kg_relationships r
  JOIN matched m
    ON r.subject_normalized = m.normalized_name
    OR r.object_normalized = m.normalized_name
  WHERE r.relation IN ('requires','unlocks','part_of','located_in','rewards','related_to')
  LIMIT 50
),
entity_names AS (
  SELECT normalized_name FROM matched
  UNION
  SELECT subject_normalized FROM first_hop
  UNION
  SELECT object_normalized FROM first_hop
),
graph_entities AS (
  SELECT DISTINCT e.*
  FROM progolf_support.progolf_kg_entities e
  JOIN entity_names n ON n.normalized_name = e.normalized_name
  WHERE e.type IN ('tournament','level','region','quest','item','mode','currency','character','other')
  LIMIT 40
)
SELECT
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
    'normalized_name', ge.normalized_name,
    'name', ge.name,
    'type', ge.type,
    'aliases', ge.aliases,
    'source_faq_ids', ge.source_faq_ids,
    'source_chunk_ids', ge.source_chunk_ids
  )) FILTER (WHERE ge.normalized_name IS NOT NULL), '[]'::jsonb) AS graph_entities,
  COALESCE((
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
      'subject_normalized', r.subject_normalized,
      'relation', r.relation,
      'object_normalized', r.object_normalized,
      'subject_name', r.subject_name,
      'object_name', r.object_name,
      'source_faq_ids', r.source_faq_ids,
      'source_chunk_ids', r.source_chunk_ids
    ))
    FROM first_hop r
  ), '[]'::jsonb) AS graph_relationships,
  COALESCE((
    SELECT array_agg(DISTINCT faq_id)
    FROM (
      SELECT unnest(COALESCE(source_faq_ids, '{}'::text[])) AS faq_id FROM graph_entities
      UNION
      SELECT unnest(COALESCE(source_faq_ids, '{}'::text[])) AS faq_id FROM first_hop
    ) ids
    WHERE faq_id IS NOT NULL AND faq_id <> ''
  ), '{}'::text[]) AS source_faq_ids
FROM graph_entities ge;`;

const emptyKgSql = `SELECT
  '[]'::jsonb AS graph_entities,
  '[]'::jsonb AS graph_relationships,
  '{}'::text[] AS source_faq_ids;`;

const executeTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'When Called By Agent',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'query', type: 'string' },
        ],
      },
    },
    position: [0, 0],
  },
  output: [{}],
});

const normalizeQuery = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize KG Query',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}
const input = $json || {};
const raw = String(input.query || input.search || input.entity || input.input || input.chatInput || '').trim();
const terms = new Set();
const normalized = normalize(raw);
if (normalized) terms.add(normalized);
for (const part of raw.split(/[,;|/\\n]/)) {
  const term = normalize(part);
  if (term.length >= 2) terms.add(term);
}
const words = normalized.split(' ').filter(Boolean);
for (let size = Math.min(4, words.length); size >= 1; size--) {
  for (let i = 0; i <= words.length - size; i++) {
    const term = words.slice(i, i + size).join(' ');
    if (term.length >= 2 && !['what','are','is','for','the','a','an','to','of','and','or','with','related'].includes(term)) terms.add(term);
  }
}
return {
  query: raw,
  seed_terms: [...terms].slice(0, 16),
  warnings: raw ? [] : ['empty_kg_query'],
};`,
    },
    position: [220, 0],
  },
  output: [{}],
});

const checkKgTables = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Check KG Tables',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT
  to_regclass('progolf_support.progolf_kg_entities') IS NOT NULL AS has_entities,
  to_regclass('progolf_support.progolf_kg_relationships') IS NOT NULL AS has_relationships;`,
      options: {},
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [440, 0],
  },
  output: [{}],
});

const retrieveKg = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Retrieve KG',
    parameters: {
      operation: 'executeQuery',
      query: `={{ $json.has_entities && $json.has_relationships && $('Normalize KG Query').item.json.seed_terms.length ? ${JSON.stringify(kgLookupSql)} : ${JSON.stringify(emptyKgSql)} }}`,
      options: {
        queryReplacement: `={{ JSON.stringify($('Normalize KG Query').item.json.seed_terms || []) }}`,
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [660, 0],
  },
  output: [{}],
});

const formatResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format KG Tool Result',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const allowedTypes = new Set(['tournament','level','region','quest','item','mode','currency','character','other']);
const allowedRelations = new Set(['requires','unlocks','part_of','located_in','rewards','related_to']);
function array(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (error) { return []; }
  }
  return [];
}
function cleanText(value, max = 120) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
}
const source = $('Normalize KG Query').item.json;
const tableCheck = $('Check KG Tables').item.json;
const warnings = [...(source.warnings || [])];
if (!tableCheck.has_entities || !tableCheck.has_relationships) warnings.push('kg_tables_missing');
const graphEntities = array($json.graph_entities)
  .filter((entity) => allowedTypes.has(entity.type) && cleanText(entity.normalized_name) && cleanText(entity.name))
  .map((entity) => ({
    normalized_name: cleanText(entity.normalized_name),
    name: cleanText(entity.name),
    type: entity.type,
    aliases: array(entity.aliases).map((alias) => cleanText(alias)).filter(Boolean).slice(0, 8),
    source_faq_ids: array(entity.source_faq_ids).map(String).filter(Boolean).slice(0, 12),
    source_chunk_ids: array(entity.source_chunk_ids).map(String).filter(Boolean).slice(0, 12),
  }));
const graphRelationships = array($json.graph_relationships)
  .filter((rel) => allowedRelations.has(rel.relation) && cleanText(rel.subject_normalized) && cleanText(rel.object_normalized))
  .map((rel) => ({
    subject_normalized: cleanText(rel.subject_normalized),
    relation: rel.relation,
    object_normalized: cleanText(rel.object_normalized),
    subject_name: cleanText(rel.subject_name || rel.subject_normalized),
    object_name: cleanText(rel.object_name || rel.object_normalized),
    source_faq_ids: array(rel.source_faq_ids).map(String).filter(Boolean).slice(0, 12),
    source_chunk_ids: array(rel.source_chunk_ids).map(String).filter(Boolean).slice(0, 12),
  }));
const sourceFaqIds = [...new Set([
  ...array($json.source_faq_ids).map(String),
  ...graphEntities.flatMap((entity) => entity.source_faq_ids),
  ...graphRelationships.flatMap((rel) => rel.source_faq_ids),
].filter(Boolean))].slice(0, 20);
const graphContextText = [
  graphEntities.length ? 'Entities: ' + graphEntities.map((e) => e.name + ' (' + e.type + ')').join('; ') : '',
  graphRelationships.length ? 'Relationships: ' + graphRelationships.map((r) => r.subject_name + ' ' + r.relation + ' ' + r.object_name).join('; ') : '',
].filter(Boolean).join('\\n');
return {
  query: source.query,
  seed_terms: source.seed_terms || [],
  graph_entities: graphEntities,
  graph_relationships: graphRelationships,
  source_faq_ids: sourceFaqIds,
  graph_context_text: graphContextText,
  warnings,
};`,
    },
    position: [880, 0],
  },
  output: [{}],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(executeTrigger)
  .to(normalizeQuery)
  .to(checkKgTables)
  .to(retrieveKg)
  .to(formatResult);
