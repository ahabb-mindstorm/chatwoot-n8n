CREATE SCHEMA IF NOT EXISTS progolf_support;

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_entities (
  normalized_name text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN (
    'tournament',
    'level',
    'region',
    'quest',
    'item',
    'mode',
    'currency',
    'character',
    'other'
  )),
  aliases text[] NOT NULL DEFAULT '{}',
  source_faq_ids text[] NOT NULL DEFAULT '{}',
  source_chunk_ids text[] NOT NULL DEFAULT '{}',
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_relationships (
  subject_normalized text NOT NULL,
  relation text NOT NULL CHECK (relation IN (
    'requires',
    'unlocks',
    'part_of',
    'located_in',
    'rewards',
    'related_to'
  )),
  object_normalized text NOT NULL,
  subject_name text NOT NULL,
  object_name text NOT NULL,
  source_faq_ids text[] NOT NULL DEFAULT '{}',
  source_chunk_ids text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_normalized, relation, object_normalized)
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_extraction_runs (
  run_id text PRIMARY KEY,
  workflow_execution_id text,
  model text NOT NULL,
  source_table text NOT NULL,
  artifact jsonb NOT NULL,
  entity_count integer NOT NULL,
  relationship_count integer NOT NULL,
  warning_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS progolf_kg_entities_type_idx
  ON progolf_support.progolf_kg_entities (type);

CREATE INDEX IF NOT EXISTS progolf_kg_relationships_relation_idx
  ON progolf_support.progolf_kg_relationships (relation);

CREATE INDEX IF NOT EXISTS progolf_kg_relationships_object_idx
  ON progolf_support.progolf_kg_relationships (object_normalized);
