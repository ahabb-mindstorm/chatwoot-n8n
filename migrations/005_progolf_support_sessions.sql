CREATE SCHEMA IF NOT EXISTS progolf_support;

CREATE TABLE IF NOT EXISTS progolf_support.progolf_support_sessions (
  conversation_id bigint PRIMARY KEY,
  account_id bigint,
  contact_id bigint,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  accumulated_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  step text NOT NULL DEFAULT 'active',
  attempts integer NOT NULL DEFAULT 0,
  last_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_support_messages (
  id bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES progolf_support.progolf_support_sessions(conversation_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, message_id, role)
);

CREATE INDEX IF NOT EXISTS progolf_support_sessions_updated_at_idx
  ON progolf_support.progolf_support_sessions (updated_at DESC);

CREATE INDEX IF NOT EXISTS progolf_support_sessions_step_idx
  ON progolf_support.progolf_support_sessions (step);

CREATE INDEX IF NOT EXISTS progolf_support_messages_conversation_created_idx
  ON progolf_support.progolf_support_messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS progolf_support_messages_metadata_gin_idx
  ON progolf_support.progolf_support_messages USING gin (metadata);
