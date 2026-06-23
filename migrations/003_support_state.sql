-- Curated support memory for the Postgres-backed Chatwoot bot.
-- Apply after migrations/001_bot_support_state.sql.

ALTER TABLE bot_conversation_state
  ADD COLUMN IF NOT EXISTS support_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS support_state_version INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN bot_conversation_state.support_state IS
  'Curated support memory passed to the model every turn. Keep full memory here, not in Chatwoot custom attributes.';

CREATE INDEX IF NOT EXISTS idx_bot_conversation_state_support_state_gin
  ON bot_conversation_state USING GIN (support_state);
