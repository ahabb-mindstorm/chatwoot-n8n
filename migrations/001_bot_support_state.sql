-- Bot support state for Chatwoot + n8n Postgres-backed workflow.
-- Apply: docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < migrations/001_bot_support_state.sql

CREATE TABLE IF NOT EXISTS bot_conversation_state (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL DEFAULT 0,
  bot_status TEXT NOT NULL DEFAULT 'idle',
  active_flow_id TEXT,
  active_flow_version INTEGER,
  current_node TEXT,
  current_step TEXT,
  flow_status TEXT NOT NULL DEFAULT 'idle',
  flow_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_intent TEXT,
  case_type TEXT,
  agent_summary TEXT,
  last_message_id TEXT,
  last_seen_at TIMESTAMPTZ,
  failed_turn_count INTEGER NOT NULL DEFAULT 0,
  clarification_pending BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_conversation_state_unique UNIQUE (account_id, conversation_id, contact_id)
);

COMMENT ON COLUMN bot_conversation_state.contact_id IS 'Use 0 when Chatwoot contact id is unknown.';

CREATE INDEX IF NOT EXISTS idx_bot_conversation_state_conversation
  ON bot_conversation_state (account_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_bot_conversation_state_active_flow
  ON bot_conversation_state (account_id, conversation_id)
  WHERE flow_status = 'active' AND active_flow_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bot_flow_submissions (
  id BIGSERIAL PRIMARY KEY,
  state_id BIGINT REFERENCES bot_conversation_state(id) ON DELETE SET NULL,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  contact_id BIGINT,
  flow_id TEXT NOT NULL,
  flow_version INTEGER,
  node_id TEXT NOT NULL,
  submission_key TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_submission JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_flow_submissions_unique UNIQUE (submission_key)
);

CREATE INDEX IF NOT EXISTS idx_bot_flow_submissions_conversation
  ON bot_flow_submissions (account_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_audit_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  contact_id BIGINT,
  source_message_id TEXT,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  route TEXT,
  intent TEXT,
  case_type TEXT,
  confidence NUMERIC(5, 4),
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_audit_events_dedupe_unique UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_bot_audit_events_conversation
  ON bot_audit_events (account_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_audit_events_type
  ON bot_audit_events (event_type, created_at DESC);
