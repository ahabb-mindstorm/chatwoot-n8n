-- Canonical per-ticket bot state scoped by agent bot.
-- Authority for phase / classification / known fields lives here — not Chatwoot custom attributes
-- and not LLM chat memory.
-- Legacy rows (no agent bot) use agent_bot_id = 0.

ALTER TABLE bot_conversation_state
  ADD COLUMN IF NOT EXISTS agent_bot_id BIGINT;

UPDATE bot_conversation_state
SET agent_bot_id = 0
WHERE agent_bot_id IS NULL;

ALTER TABLE bot_conversation_state
  ALTER COLUMN agent_bot_id SET DEFAULT 0,
  ALTER COLUMN agent_bot_id SET NOT NULL;

ALTER TABLE bot_conversation_state
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'idle';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bot_conversation_state_phase_check'
      AND conrelid = 'bot_conversation_state'::regclass
  ) THEN
    ALTER TABLE bot_conversation_state
      ADD CONSTRAINT bot_conversation_state_phase_check
      CHECK (phase IN ('idle', 'clarify', 'self_serve', 'route', 'handoff', 'human_owned'));
  END IF;
END $$;

ALTER TABLE bot_conversation_state
  DROP CONSTRAINT IF EXISTS bot_conversation_state_unique;

-- Collapse any legacy duplicates before the bot-scoped unique key.
DELETE FROM bot_conversation_state a
  USING bot_conversation_state b
 WHERE a.account_id = b.account_id
   AND a.conversation_id = b.conversation_id
   AND COALESCE(a.agent_bot_id, 0) = COALESCE(b.agent_bot_id, 0)
   AND a.id < b.id;

-- One canonical row per bot × conversation. contact_id remains informational.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bot_conversation_state_bot_unique'
      AND conrelid = 'bot_conversation_state'::regclass
  ) THEN
    ALTER TABLE bot_conversation_state
      ADD CONSTRAINT bot_conversation_state_bot_unique
      UNIQUE (account_id, conversation_id, agent_bot_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bot_conversation_state_agent_bot
  ON bot_conversation_state (agent_bot_id, account_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_bot_conversation_state_phase
  ON bot_conversation_state (agent_bot_id, phase)
  WHERE phase <> 'idle';

COMMENT ON COLUMN bot_conversation_state.agent_bot_id IS
  'Owning Helio agent bot. 0 = legacy / unscoped.';
COMMENT ON COLUMN bot_conversation_state.phase IS
  'Canonical ticket phase: idle | clarify | self_serve | route | handoff | human_owned.';
COMMENT ON COLUMN bot_conversation_state.support_state IS
  'Curated ticket fields (category, known_fields, pending_clarification, …). Not Chatwoot authority.';

CREATE OR REPLACE FUNCTION bot_load_ticket_state(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_agent_bot_id BIGINT DEFAULT 0
)
RETURNS TABLE (
  found BOOLEAN,
  phase TEXT,
  bot_status TEXT,
  case_type TEXT,
  last_intent TEXT,
  support_state JSONB,
  support_state_version INTEGER,
  clarification_pending BOOLEAN,
  last_message_id TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_agent_bot_id BIGINT := COALESCE(p_agent_bot_id, 0);
BEGIN
  RETURN QUERY
  SELECT
    TRUE,
    s.phase,
    s.bot_status,
    s.case_type,
    s.last_intent,
    s.support_state,
    s.support_state_version,
    s.clarification_pending,
    s.last_message_id,
    s.updated_at
  FROM bot_conversation_state s
  WHERE s.account_id = p_account_id
    AND s.conversation_id = p_conversation_id
    AND s.agent_bot_id = v_agent_bot_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT
      FALSE,
      'idle'::TEXT,
      'idle'::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      '{}'::JSONB,
      1,
      FALSE,
      NULL::TEXT,
      NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION bot_upsert_ticket_state(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_agent_bot_id BIGINT,
  p_phase TEXT DEFAULT 'idle',
  p_bot_status TEXT DEFAULT NULL,
  p_case_type TEXT DEFAULT NULL,
  p_last_intent TEXT DEFAULT NULL,
  p_support_state JSONB DEFAULT '{}'::jsonb,
  p_clarification_pending BOOLEAN DEFAULT FALSE,
  p_last_message_id TEXT DEFAULT NULL,
  p_contact_id BIGINT DEFAULT 0
)
RETURNS TABLE (
  id BIGINT,
  phase TEXT,
  support_state JSONB,
  support_state_version INTEGER,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_agent_bot_id BIGINT := COALESCE(p_agent_bot_id, 0);
  v_phase TEXT := COALESCE(NULLIF(TRIM(p_phase), ''), 'idle');
BEGIN
  IF v_phase NOT IN ('idle', 'clarify', 'self_serve', 'route', 'handoff', 'human_owned') THEN
    v_phase := 'idle';
  END IF;

  RETURN QUERY
  INSERT INTO bot_conversation_state AS s (
    account_id,
    conversation_id,
    contact_id,
    agent_bot_id,
    phase,
    bot_status,
    case_type,
    last_intent,
    support_state,
    clarification_pending,
    last_message_id,
    last_seen_at,
    updated_at
  ) VALUES (
    p_account_id,
    p_conversation_id,
    COALESCE(p_contact_id, 0),
    v_agent_bot_id,
    v_phase,
    COALESCE(NULLIF(TRIM(p_bot_status), ''), v_phase),
    NULLIF(TRIM(p_case_type), ''),
    NULLIF(TRIM(p_last_intent), ''),
    COALESCE(p_support_state, '{}'::jsonb),
    COALESCE(p_clarification_pending, FALSE),
    NULLIF(TRIM(p_last_message_id), ''),
    clock_timestamp(),
    clock_timestamp()
  )
  ON CONFLICT (account_id, conversation_id, agent_bot_id) DO UPDATE
  SET
    phase = EXCLUDED.phase,
    bot_status = EXCLUDED.bot_status,
    case_type = COALESCE(EXCLUDED.case_type, s.case_type),
    last_intent = COALESCE(EXCLUDED.last_intent, s.last_intent),
    support_state = EXCLUDED.support_state,
    support_state_version = s.support_state_version + 1,
    clarification_pending = EXCLUDED.clarification_pending,
    last_message_id = COALESCE(EXCLUDED.last_message_id, s.last_message_id),
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
  RETURNING s.id, s.phase, s.support_state, s.support_state_version, s.updated_at;
END;
$$;
