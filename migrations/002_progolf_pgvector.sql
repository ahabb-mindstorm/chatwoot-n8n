-- ProGolf FAQ vectors in Chatwoot Postgres.
-- Apply against the Chatwoot database, not the local bot-state database.
--
-- Recommended n8n DB role setup, run separately with your chosen password:
--   CREATE ROLE progolf_support_rag LOGIN PASSWORD '<strong-password>';
--   ALTER ROLE progolf_support_rag SET search_path = progolf_support, public;
--
-- The grants below are applied automatically if progolf_support_rag already exists.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS progolf_support;

CREATE TABLE IF NOT EXISTS progolf_support.progolf_faq_vectors (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION progolf_support.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_progolf_faq_vectors_updated_at
  ON progolf_support.progolf_faq_vectors;

CREATE TRIGGER set_progolf_faq_vectors_updated_at
BEFORE UPDATE ON progolf_support.progolf_faq_vectors
FOR EACH ROW
EXECUTE FUNCTION progolf_support.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_progolf_faq_vectors_embedding_hnsw
  ON progolf_support.progolf_faq_vectors
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_progolf_faq_vectors_faq_id
  ON progolf_support.progolf_faq_vectors ((metadata->>'faq_id'));

CREATE INDEX IF NOT EXISTS idx_progolf_faq_vectors_topic
  ON progolf_support.progolf_faq_vectors ((metadata->>'topic'));

CREATE INDEX IF NOT EXISTS idx_progolf_faq_vectors_source
  ON progolf_support.progolf_faq_vectors ((metadata->>'source'));

CREATE INDEX IF NOT EXISTS idx_progolf_faq_vectors_metadata_gin
  ON progolf_support.progolf_faq_vectors
  USING gin (metadata jsonb_path_ops);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'progolf_support_rag') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA progolf_support TO progolf_support_rag';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON progolf_support.progolf_faq_vectors TO progolf_support_rag';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO progolf_support_rag';
  END IF;
END $$;
